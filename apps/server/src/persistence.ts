import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { type ActivityEvent, ClaudeSession, Project } from '@yardmaster/protocol';
import { z } from 'zod';
import { DB_FILE, prepareDbFile } from './data-dir.js';
import type { BoardStore } from './store.js';

export { DB_FILE };
export const ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Queued writes are flushed this long after the first one, or sooner when the batch is full. */
export const WRITE_DELAY_MS = 250;
export const MAX_WRITE_BATCH = 500;

const SCHEMA_VERSION = 1;
const MAX_SETTING_KEY = 128;

/**
 * What survives a restart of a session: metadata only, no transcript content. `run` is a board
 * session's query, still open (`idle`, or mid-`turn`) when written; it comes back interrupted.
 */
export const SessionRecord = ClaudeSession.pick({
  id: true,
  origin: true,
  projectId: true,
  cwd: true,
  branch: true,
  title: true,
  customTitle: true,
  ordinal: true,
  forkedFrom: true,
  model: true,
  permissionMode: true,
  tokens: true,
  transcriptPath: true,
  startedAt: true,
  updatedAt: true,
  endedAt: true,
}).extend({ run: z.enum(['idle', 'turn']).nullable().optional() });
export type SessionRecord = z.infer<typeof SessionRecord>;

export interface PersistenceLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface PersistenceOptions {
  /** Directory holding `board.db`. Ignored when `path` is given. */
  home?: string;
  /** Database file, or `:memory:`. Defaults to `<home>/board.db`. */
  path?: string;
  now?: () => number;
  logger?: PersistenceLogger;
  retentionMs?: number;
  pruneIntervalMs?: number;
  writeDelayMs?: number;
  maxBatch?: number;
}

export interface ActivityQuery {
  since?: number;
  until?: number;
  projectId?: string;
  sessionId?: string;
  limit?: number;
}

const ActivityRow = z.object({
  id: z.string(),
  ts: z.number(),
  kind: z.string(),
  project_id: z.string().nullable(),
  session_id: z.string().nullable(),
  terminal_id: z.string().nullable(),
  exec_id: z.string().nullable(),
  summary: z.string().nullable(),
  data: z.string(),
});

const silentLogger: PersistenceLogger = { warn() {}, error() {} };

/**
 * The board's sqlite database: projects, session metadata, activity events
 * and settings. Projects, sessions and activity are queued and written in
 * one transaction per batch, off the ingest path; settings are written
 * immediately. Activity older than the retention window is pruned hourly.
 */
export class Persistence {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly log: PersistenceLogger;
  private retentionMs: number;
  private readonly writeDelayMs: number;
  private readonly maxBatch: number;
  private readonly stmt: Record<
    | 'upsertProject'
    | 'deleteProject'
    | 'upsertSession'
    | 'insertActivity'
    | 'pruneActivity'
    | 'upsertSetting'
    | 'deleteSetting',
    StatementSync
  >;

  private activity: ActivityEvent[] = [];
  /** Pending project writes; `null` deletes. */
  private projects = new Map<string, Project | null>();
  private sessions = new Map<string, SessionRecord>();
  private writeTimer: NodeJS.Timeout | undefined;
  private readonly pruneTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: PersistenceOptions = {}) {
    if (!options.path && !options.home) throw new Error('Persistence needs a home or a path');
    this.path = options.path ?? join(options.home as string, DB_FILE);
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? silentLogger;
    this.retentionMs = options.retentionMs ?? ACTIVITY_RETENTION_MS;
    this.writeDelayMs = options.writeDelayMs ?? WRITE_DELAY_MS;
    this.maxBatch = options.maxBatch ?? MAX_WRITE_BATCH;

    if (this.path !== ':memory:' && !options.path) {
      mkdirSync(options.home as string, { recursive: true, mode: 0o700 });
    }
    if (this.path !== ':memory:') prepareDbFile(this.path);
    this.db = new DatabaseSync(this.path);
    migrate(this.db);

    this.stmt = {
      upsertProject: this.db.prepare(
        `INSERT INTO projects (id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      ),
      deleteProject: this.db.prepare('DELETE FROM projects WHERE id = ?'),
      upsertSession: this.db.prepare(
        `INSERT INTO sessions (id, project_id, started_at, updated_at, ended_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id,
           started_at = excluded.started_at, updated_at = excluded.updated_at,
           ended_at = excluded.ended_at, data = excluded.data`,
      ),
      insertActivity: this.db.prepare(
        `INSERT OR IGNORE INTO activity
           (id, ts, kind, project_id, session_id, terminal_id, exec_id, summary, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      pruneActivity: this.db.prepare('DELETE FROM activity WHERE ts < ?'),
      upsertSetting: this.db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ),
      deleteSetting: this.db.prepare('DELETE FROM settings WHERE key = ?'),
    };

    this.prune();
    const pruneIntervalMs = options.pruneIntervalMs ?? PRUNE_INTERVAL_MS;
    if (pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
      this.pruneTimer.unref();
    }
  }

  // Boot

  loadProjects(): Project[] {
    return this.loadJson('projects', 'SELECT id, data FROM projects ORDER BY id', Project);
  }

  loadSessions(): SessionRecord[] {
    return this.loadJson(
      'sessions',
      'SELECT id, data FROM sessions ORDER BY started_at, id',
      SessionRecord,
    );
  }

  /** Token usage of a project's stored sessions, including writes not yet flushed. */
  sessionTokens(projectId: string): Map<string, SessionRecord['tokens']> {
    const tokens = new Map<string, SessionRecord['tokens']>();
    this.flush();
    if (this.closed) return tokens;
    const rows = this.db
      .prepare('SELECT id, data FROM sessions WHERE project_id = ?')
      .all(projectId);
    for (const row of rows) {
      try {
        const record = SessionRecord.safeParse(JSON.parse(String(row.data)));
        if (record.success) tokens.set(record.data.id, record.data.tokens);
      } catch {
        // An unreadable row only costs that session its token count.
      }
    }
    return tokens;
  }

  loadSettings(): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      const key = String(row.key);
      try {
        settings[key] = JSON.parse(String(row.value));
      } catch (err) {
        this.log.warn({ err, key }, 'skipping unreadable setting');
      }
    }
    return settings;
  }

  // Writes

  saveProject(project: Project): void {
    this.projects.set(project.id, project);
    this.queued();
  }

  deleteProject(id: string): void {
    this.projects.set(id, null);
    this.queued();
  }

  saveSession(session: ClaudeSession | SessionRecord): void {
    this.sessions.set(session.id, toSessionRecord(session));
    this.queued();
  }

  recordActivity(event: ActivityEvent): void {
    this.activity.push(event);
    this.queued();
  }

  /** Writes immediately. `undefined` removes the key. */
  setSetting(key: string, value: unknown): void {
    if (key.length === 0 || key.length > MAX_SETTING_KEY) {
      throw new RangeError(`setting key must be 1-${MAX_SETTING_KEY} characters`);
    }
    if (this.closed) return;
    if (value === undefined) {
      this.stmt.deleteSetting.run(key);
      return;
    }
    this.stmt.upsertSetting.run(key, JSON.stringify(value));
  }

  /**
   * Mirrors project and session changes from the store. Removed projects are
   * deleted; removed sessions keep their history row. Returns an unsubscribe.
   */
  attach(store: BoardStore): () => void {
    return store.onPatch((ops) => {
      const projectIds = new Set<string>();
      const sessionIds = new Set<string>();
      for (const { path } of ops) {
        const [collection, id] = path;
        const ids =
          collection === 'projects' ? projectIds : collection === 'sessions' ? sessionIds : null;
        if (!ids) continue;
        if (id !== undefined) ids.add(id);
        // A whole-collection op: re-save everything currently in it.
        else for (const key of Object.keys(store.state[collection as 'projects'])) ids.add(key);
      }
      for (const id of projectIds) {
        const project = store.state.projects[id];
        if (project) this.saveProject(project);
        else this.deleteProject(id);
      }
      for (const id of sessionIds) {
        const session = store.state.sessions[id];
        if (session) this.saveSession(session);
      }
    });
  }

  /** Writes everything queued in one transaction. */
  flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    if (this.closed) return;
    if (this.activity.length === 0 && this.projects.size === 0 && this.sessions.size === 0) return;

    const activity = this.activity;
    const projects = this.projects;
    const sessions = this.sessions;
    this.activity = [];
    this.projects = new Map();
    this.sessions = new Map();

    const ts = this.now();
    try {
      this.db.exec('BEGIN');
      for (const [id, project] of projects) {
        if (project) this.stmt.upsertProject.run(id, JSON.stringify(project), ts);
        else this.stmt.deleteProject.run(id);
      }
      for (const s of sessions.values()) {
        this.stmt.upsertSession.run(
          s.id,
          s.projectId,
          s.startedAt,
          s.updatedAt,
          s.endedAt,
          JSON.stringify(s),
        );
      }
      for (const event of activity) this.writeActivity(event);
      this.db.exec('COMMIT');
    } catch (err) {
      // Dropping the batch keeps memory bounded if the disk keeps failing.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.log.error(
        { err, activity: activity.length, projects: projects.size, sessions: sessions.size },
        'failed to write batch',
      );
    }
  }

  // Activity

  get retention(): number {
    return this.retentionMs;
  }

  /** Changes the retention window and prunes right away, so a shorter one applies at once. */
  setRetention(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0)
      throw new RangeError('retention must be a positive duration');
    this.retentionMs = ms;
    this.prune();
  }

  /** Deletes activity older than the retention window. Returns the number of rows removed. */
  prune(now = this.now()): number {
    if (this.closed) return 0;
    this.flush();
    try {
      const { changes } = this.stmt.pruneActivity.run(now - this.retentionMs);
      return Number(changes);
    } catch (err) {
      this.log.error({ err }, 'failed to prune activity');
      return 0;
    }
  }

  /** Activity in time order (oldest first), including events not yet flushed. */
  listActivity(query: ActivityQuery = {}): ActivityEvent[] {
    this.flush();
    const filters: [string, string | number | undefined][] = [
      ['ts >= ?', query.since],
      ['ts <= ?', query.until],
      ['project_id = ?', query.projectId],
      ['session_id = ?', query.sessionId],
    ];
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const [clause, value] of filters) {
      if (value === undefined) continue;
      where.push(clause);
      params.push(value);
    }
    const limit = Math.max(0, Math.min(query.limit ?? 1000, 10_000));
    // Take the newest `limit` rows, then return them oldest first.
    const sql = `SELECT * FROM (SELECT rowid AS seq, * FROM activity ${
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    } ORDER BY ts DESC, seq DESC LIMIT ?) ORDER BY ts, seq`;

    const events: ActivityEvent[] = [];
    for (const raw of this.db.prepare(sql).all(...params, limit)) {
      const row = ActivityRow.safeParse(raw);
      if (!row.success) continue;
      try {
        events.push({
          id: row.data.id,
          ts: row.data.ts,
          kind: row.data.kind as ActivityEvent['kind'],
          projectId: row.data.project_id,
          sessionId: row.data.session_id,
          terminalId: row.data.terminal_id,
          execId: row.data.exec_id,
          summary: row.data.summary,
          data: JSON.parse(row.data.data) as Record<string, unknown>,
        });
      } catch (err) {
        this.log.warn({ err, id: row.data.id }, 'skipping unreadable activity row');
      }
    }
    return events;
  }

  /** Flushes pending writes and closes the database. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flush();
    this.closed = true;
    this.db.close();
  }

  // Internals

  private queued(): void {
    if (this.closed) return;
    const pending = this.activity.length + this.projects.size + this.sessions.size;
    if (pending >= this.maxBatch) {
      this.flush();
      return;
    }
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => this.flush(), this.writeDelayMs);
      this.writeTimer.unref();
    }
  }

  private writeActivity(event: ActivityEvent): void {
    let data: string;
    try {
      data = JSON.stringify(event.data ?? {});
    } catch (err) {
      this.log.warn({ err, id: event.id }, 'skipping activity event with unserializable data');
      return;
    }
    this.stmt.insertActivity.run(
      event.id,
      event.ts,
      event.kind,
      event.projectId,
      event.sessionId,
      event.terminalId,
      event.execId,
      event.summary,
      data,
    );
  }

  private loadJson<T>(table: string, sql: string, schema: z.ZodType<T>): T[] {
    const items: T[] = [];
    for (const row of this.db.prepare(sql).all()) {
      let parsed: z.ZodSafeParseResult<T>;
      try {
        parsed = schema.safeParse(JSON.parse(String(row.data)));
      } catch (err) {
        this.log.warn({ err, table, id: row.id }, 'skipping unreadable row');
        continue;
      }
      if (parsed.success) items.push(parsed.data);
      else
        this.log.warn({ table, id: row.id, issues: parsed.error.issues }, 'skipping invalid row');
    }
    return items;
  }
}

export function toSessionRecord(session: ClaudeSession | SessionRecord): SessionRecord {
  const run = 'status' in session ? boardRun(session) : (session.run ?? null);
  return {
    id: session.id,
    origin: session.origin,
    projectId: session.projectId,
    cwd: session.cwd,
    ...(session.branch ? { branch: session.branch } : {}),
    title: session.title,
    ...(session.customTitle ? { customTitle: session.customTitle } : {}),
    ...(session.ordinal ? { ordinal: session.ordinal } : {}),
    ...(session.forkedFrom ? { forkedFrom: session.forkedFrom } : {}),
    model: session.model,
    permissionMode: session.permissionMode,
    tokens: session.tokens,
    transcriptPath: session.transcriptPath,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    ...(run ? { run } : {}),
  };
}

/** Statuses of a board session whose query is still open. */
const IDLE_RUN = new Set(['idle', 'waiting_input', 'unknown']);
const TURN_RUN = new Set(['working', 'tool', 'waiting_permission', 'compacting']);

function boardRun(session: ClaudeSession): SessionRecord['run'] {
  if (session.origin !== 'board') return null;
  const { status } = session;
  if (status.kind === 'interrupted') return status.turnRunning ? 'turn' : 'idle';
  if (TURN_RUN.has(status.kind)) return 'turn';
  return IDLE_RUN.has(status.kind) ? 'idle' : null;
}

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
  const row = db.prepare('PRAGMA user_version').get();
  const version = Number(row?.user_version ?? 0);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `board.db schema v${version} is newer than this Yardmaster (v${SCHEMA_VERSION})`,
    );
  }
  if (version === SCHEMA_VERSION) return;
  db.exec(`
    BEGIN;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project_id, started_at);
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      terminal_id TEXT,
      exec_id TEXT,
      summary TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_ts ON activity (ts);
    CREATE INDEX IF NOT EXISTS activity_project_ts ON activity (project_id, ts);
    CREATE INDEX IF NOT EXISTS activity_session_ts ON activity (session_id, ts);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `);
}

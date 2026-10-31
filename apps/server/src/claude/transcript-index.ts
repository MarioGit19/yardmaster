import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { claudeSettingsPath } from '@yardmaster/hook';
import {
  type ChatMessage,
  type ClaudeSession,
  decodeChatMessage,
  isArchivedSession,
  type SearchHit,
  type SearchIndexStatus,
  type SearchRequest,
  type SearchResponse,
  type SearchRun,
  type SearchTranscriptResponse,
  SessionId,
  sessionDisplayName,
  sessionIdFromStream,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { isInside } from '../library.js';
import { SEARCH_FTS_TABLE } from '../persistence.js';
import type { BoardStore } from '../store.js';
import { JsonlTail } from './jsonl-tail.js';
import { deepestProject } from './project-lookup.js';
import {
  aiTitleOf,
  customTitleOf,
  normalizeEntry,
  parseTranscriptLine,
} from './transcript-normalize.js';
import { encodeProjectDir } from './transcript-service.js';

/** How often the transcripts on disk are checked; live sessions are indexed as they speak. */
export const SCAN_INTERVAL_MS = 5 * 60_000;
/** Wait after boot, so indexing never competes with the board coming up. */
export const SCAN_DELAY_MS = 3_000;
const LIVE_FLUSH_MS = 1_000;
const MAX_LIVE_QUEUE = 500;
/** Bytes of a transcript read at a time, so a huge one can't fill memory. */
const READ_BYTES = 8 * 1024 * 1024;
/** A message's text beyond this isn't indexed. */
const MAX_BODY = 64 * 1024;
/** New text between two checks of the size limit. */
const TRIM_EVERY_BYTES = 16 * 1024 * 1024;
/** Text plus its full-text index, per byte of text. An estimate: it is read on every check. */
const STORED_PER_BYTE = 2;
/** Matches read per search: enough to fill a page after the per-session cap. */
const MATCH_WINDOW = 500;
const HITS_PER_SESSION = 3;
const SNIPPET_TOKENS = 28;
/** Messages returned around a result. */
export const TRANSCRIPT_WINDOW = 600;

// Private-use characters, stripped from the text, so a transcript can't fake a highlight.
const HIT_OPEN = '';
const HIT_CLOSE = '';
const HIT_MARKS = /[]/g;

export interface TranscriptIndexSettings {
  maxBytes: number;
  includeTools: boolean;
}

/** Publishes every message of every session it reads, as `TranscriptService` does. */
export interface TranscriptFollower {
  onData(listener: (streamId: string, seq: number, chunk: string) => void): () => void;
}

/** A session's messages in order: the demo's, which live in memory. */
export type MessageReader = (sessionId: string) => readonly ChatMessage[] | null;

export interface TranscriptIndexOptions {
  db: DatabaseSync;
  store: BoardStore;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  settings: () => TranscriptIndexSettings;
  /** Messages older than this stay out: the index was cleared then. */
  floor: () => number;
  setFloor: (ts: number) => void;
  /** Where `projects/` lives; null when there are no transcript files (the demo). */
  claudeConfigDir?: string | null;
  /** Hands over everything held in memory, when there are no files to read. */
  replay?: (add: (sessionId: string, message: ChatMessage) => void) => void;
  readMessages?: MessageReader;
  now?: () => number;
  intervalMs?: number;
  delayMs?: number;
}

interface TranscriptFile {
  id: string;
  dir: string;
  path: string;
  size: number;
  mtime: number;
}

interface SessionFacts {
  projectId: string | null;
  cwd: string | null;
  path: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  startedAt: number | null;
  updatedAt: number;
}

const SessionRow = z.object({
  session_id: z.string(),
  project_id: z.string().nullable(),
  cwd: z.string().nullable(),
  path: z.string().nullable(),
  custom_title: z.string().nullable(),
  ai_title: z.string().nullable(),
  first_prompt: z.string().nullable(),
  offset: z.number(),
  floor: z.number(),
  updated_at: z.number(),
});
type SessionRow = z.infer<typeof SessionRow>;

const HitRow = SessionRow.pick({
  session_id: true,
  project_id: true,
  cwd: true,
  custom_title: true,
  ai_title: true,
  first_prompt: true,
}).extend({
  message_id: z.string(),
  kind: z.enum(['user', 'assistant', 'tool_use', 'tool_result']),
  ts: z.number().nullable(),
  snippet: z.string(),
});

const CwdLine = z.looseObject({ cwd: z.string().min(1).max(4096) });

/**
 * Local full-text search over every transcript, in `board.db`. A pass over the `projects` folder
 * reads each file from where the last pass stopped, through the same tolerant parser as the
 * transcript reader; the reader's own stream indexes live sessions as they speak, and ids
 * de-duplicate the two. Past the size limit the oldest sessions are dropped. Nothing here makes a
 * network call.
 */
export class TranscriptIndex {
  private readonly db: DatabaseSync;
  private readonly store: BoardStore;
  private readonly log: TranscriptIndexOptions['logger'];
  private readonly settings: () => TranscriptIndexSettings;
  private readonly floor: () => number;
  private readonly setFloor: (ts: number) => void;
  private readonly configDir: string | null;
  private readonly replay: TranscriptIndexOptions['replay'];
  private readonly readMessages: MessageReader | undefined;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly delayMs: number;
  private readonly stmt: Record<
    | 'upsertSession'
    | 'setOffset'
    | 'addCounts'
    | 'insertMessage'
    | 'fillTs'
    | 'insertText'
    | 'getSession'
    | 'dropText'
    | 'dropMessages'
    | 'evict',
    StatementSync
  >;
  /** Folders of forgotten projects, with the project's path: skipped until it comes back. */
  private readonly skipped = new Map<string, string>();
  private live = new Map<string, ChatMessage[]>();
  private queued = 0;
  private liveTimer: NodeJS.Timeout | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private stopFollowing: (() => void) | undefined;
  private scanning: Promise<void> | null = null;
  private again = false;
  /** Bumped by whatever invalidates a running pass (clearing, forgetting). */
  private generation = 0;
  private sinceTrim = 0;
  private trimmed = 0;
  private lastIndexedAt: number | null = null;
  private closed = false;

  constructor(options: TranscriptIndexOptions) {
    this.db = options.db;
    this.store = options.store;
    this.log = options.logger;
    this.settings = options.settings;
    this.floor = options.floor;
    this.setFloor = options.setFloor;
    this.configDir =
      options.claudeConfigDir === undefined
        ? dirname(claudeSettingsPath(process.env, homedir()))
        : options.claudeConfigDir;
    this.replay = options.replay;
    this.readMessages = options.readMessages;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? SCAN_INTERVAL_MS;
    this.delayMs = options.delayMs ?? SCAN_DELAY_MS;
    this.stmt = {
      upsertSession: this.db.prepare(
        `INSERT INTO search_sessions
           (session_id, project_id, cwd, path, custom_title, ai_title, first_prompt,
            started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           project_id = COALESCE(excluded.project_id, project_id),
           cwd = COALESCE(cwd, excluded.cwd),
           path = COALESCE(excluded.path, path),
           custom_title = COALESCE(excluded.custom_title, custom_title),
           ai_title = COALESCE(excluded.ai_title, ai_title),
           first_prompt = COALESCE(first_prompt, excluded.first_prompt),
           started_at = MIN(COALESCE(started_at, excluded.started_at),
                            COALESCE(excluded.started_at, started_at)),
           updated_at = MAX(updated_at, excluded.updated_at)`,
      ),
      setOffset: this.db.prepare('UPDATE search_sessions SET offset = ? WHERE session_id = ?'),
      addCounts: this.db.prepare(
        `UPDATE search_sessions SET messages = messages + ?, bytes = bytes + ?
         WHERE session_id = ?`,
      ),
      insertMessage: this.db.prepare(
        `INSERT OR IGNORE INTO search_messages (session_id, message_id, kind, ts)
         VALUES (?, ?, ?, ?)`,
      ),
      fillTs: this.db.prepare(
        `UPDATE search_messages SET ts = ? WHERE session_id = ? AND message_id = ? AND ts IS NULL`,
      ),
      insertText: this.db.prepare('INSERT INTO search_fts (rowid, body) VALUES (?, ?)'),
      getSession: this.db.prepare('SELECT * FROM search_sessions WHERE session_id = ?'),
      dropText: this.db.prepare(
        `DELETE FROM search_fts WHERE rowid IN
           (SELECT id FROM search_messages WHERE session_id = ?)`,
      ),
      dropMessages: this.db.prepare('DELETE FROM search_messages WHERE session_id = ?'),
      evict: this.db.prepare(
        `UPDATE search_sessions SET messages = 0, bytes = 0, floor = ? WHERE session_id = ?`,
      ),
    };
    for (const row of this.db.prepare('SELECT dir, project_path FROM search_skipped').all()) {
      this.skipped.set(String(row.dir), String(row.project_path));
    }
  }

  /** Indexes `source`'s messages as they are read. */
  follow(source: TranscriptFollower): void {
    this.stopFollowing?.();
    this.stopFollowing = source.onData((streamId, _seq, chunk) => {
      const sessionId = sessionIdFromStream(streamId);
      const message = sessionId === null ? null : decodeChatMessage(chunk);
      if (sessionId !== null && message) this.enqueue(sessionId, message);
    });
  }

  /** Runs a pass shortly, then on an interval. */
  start(): void {
    if (this.closed || this.interval) return;
    this.startTimer = setTimeout(() => void this.scan(), this.delayMs);
    this.startTimer.unref();
    this.interval = setInterval(() => void this.scan(), this.intervalMs);
    this.interval.unref();
  }

  /** One pass over what isn't indexed yet. Never throws; overlapping calls run once more. */
  scan(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    this.scanning = this.pass().finally(() => {
      this.scanning = null;
      if (this.again && !this.closed) {
        this.again = false;
        void this.scan();
      }
    });
    return this.scanning;
  }

  private async pass(): Promise<void> {
    const generation = this.generation;
    try {
      this.replay?.((sessionId, message) => this.enqueue(sessionId, message));
      this.flushLive();
      if (this.configDir !== null) {
        for (const file of await this.listTranscripts(this.configDir)) {
          if (this.closed || generation !== this.generation) return;
          await this.readFile(file, generation);
        }
      }
      this.assignProjects();
      this.trim();
      this.lastIndexedAt = this.now();
    } catch (err) {
      this.log.warn({ err }, 'transcript indexing failed');
    }
  }

  private async listTranscripts(configDir: string): Promise<TranscriptFile[]> {
    const root = join(configDir, 'projects');
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    const files: TranscriptFile[] = [];
    this.unskipReturned();
    for (const dir of dirs) {
      if (!dir.isDirectory() || this.skipped.has(dir.name)) continue;
      const folder = join(root, dir.name);
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const id = SessionId.safeParse(entry.name.slice(0, -'.jsonl'.length));
        if (!id.success) continue;
        const path = join(folder, entry.name);
        const info = await stat(path).catch(() => null);
        if (info?.isFile()) {
          files.push({
            id: id.data,
            dir: dir.name,
            path,
            size: info.size,
            mtime: Math.trunc(info.mtimeMs),
          });
        }
      }
    }
    // Newest first: recent work is searchable soonest, and the limit drops the oldest.
    return files.sort((a, b) => b.mtime - a.mtime);
  }

  /** Reads what's new in a transcript, committing the text and the offset together. */
  private async readFile(file: TranscriptFile, generation: number): Promise<void> {
    const before = this.row(file.id);
    const start = before && before.offset <= file.size ? before.offset : 0;
    if (start === file.size) return;
    const tail = new JsonlTail(file.path, start);
    const facts: SessionFacts = {
      projectId: null,
      cwd: before?.cwd ?? null,
      path: file.path,
      customTitle: null,
      aiTitle: null,
      firstPrompt: null,
      startedAt: null,
      updatedAt: file.mtime,
    };
    let limit = READ_BYTES;
    while (tail.offset < file.size) {
      const at = tail.offset;
      const { lines } = await tail.read(limit);
      if (this.closed || generation !== this.generation) return;
      const messages: ChatMessage[] = [];
      for (const line of lines) {
        const entry = parseTranscriptLine(line);
        if (entry === null) {
          this.log.debug({ sessionId: file.id }, 'skipped bad transcript line');
          continue;
        }
        facts.customTitle = customTitleOf(entry) ?? facts.customTitle;
        facts.aiTitle = aiTitleOf(entry) ?? facts.aiTitle;
        facts.cwd ??= CwdLine.safeParse(entry).data?.cwd ?? null;
        messages.push(...normalizeEntry(entry));
      }
      this.write(file.id, facts, messages, tail.offset);
      // One line longer than the window: widen it rather than stall on the file.
      if (tail.offset === at) {
        if (at + limit >= file.size) break;
        limit *= 2;
      } else {
        limit = READ_BYTES;
      }
      await new Promise((done) => setImmediate(done));
    }
    if (this.sinceTrim >= TRIM_EVERY_BYTES) this.trim();
  }

  /** Whole messages only reach here, in one transaction with the offset they end at. */
  private write(
    sessionId: string,
    facts: SessionFacts,
    messages: readonly ChatMessage[],
    offset: number | null,
  ): void {
    const { includeTools } = this.settings();
    const global = this.floor();
    const floor = Math.max(global, this.row(sessionId)?.floor ?? 0);
    this.db.exec('BEGIN');
    try {
      const typed = messages.find((m) => m.kind === 'user' && !m.meta);
      const firstPrompt = facts.firstPrompt ?? (typed?.kind === 'user' ? typed.text : null);
      let startedAt = facts.startedAt;
      for (const message of messages) {
        if (message.ts !== null && (startedAt === null || message.ts < startedAt)) {
          startedAt = message.ts;
        }
      }
      this.stmt.upsertSession.run(
        sessionId,
        facts.projectId ?? this.projectOf(facts.cwd),
        facts.cwd,
        facts.path,
        facts.customTitle,
        facts.aiTitle,
        firstPrompt === null ? null : firstPrompt.slice(0, 200),
        startedAt,
        facts.updatedAt,
      );
      let added = 0;
      let bytes = 0;
      for (const message of messages) {
        if (floor > 0 && (message.ts === null || message.ts < floor)) continue;
        const body = searchableText(message, includeTools);
        if (body === null) continue;
        const { changes, lastInsertRowid } = this.stmt.insertMessage.run(
          sessionId,
          message.id,
          message.kind,
          message.ts,
        );
        if (Number(changes) === 0) {
          if (message.ts !== null) this.stmt.fillTs.run(message.ts, sessionId, message.id);
          continue;
        }
        this.stmt.insertText.run(lastInsertRowid, body);
        added += 1;
        bytes += Buffer.byteLength(body);
      }
      if (added > 0) this.stmt.addCounts.run(added, bytes, sessionId);
      if (offset !== null) this.stmt.setOffset.run(offset, sessionId);
      this.db.exec('COMMIT');
      this.sinceTrim += bytes;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private enqueue(sessionId: string, message: ChatMessage): void {
    if (this.closed || searchableText(message, true) === null) return;
    const list = this.live.get(sessionId);
    if (list) list.push(message);
    else this.live.set(sessionId, [message]);
    this.queued += 1;
    if (this.queued >= MAX_LIVE_QUEUE) {
      this.flushLive();
      return;
    }
    if (!this.liveTimer) {
      this.liveTimer = setTimeout(() => this.flushLive(), LIVE_FLUSH_MS);
      this.liveTimer.unref();
    }
  }

  private flushLive(): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    const live = this.live;
    this.live = new Map();
    this.queued = 0;
    if (this.closed) return;
    for (const [sessionId, messages] of live) {
      const session = this.store.state.sessions[sessionId];
      if (this.isForgotten(session)) continue;
      try {
        this.write(sessionId, liveFacts(session, this.now()), messages, null);
      } catch (err) {
        this.log.warn({ err, sessionId }, 'could not index messages');
      }
    }
    if (this.sinceTrim >= TRIM_EVERY_BYTES) this.trim();
  }

  private isForgotten(session: ClaudeSession | undefined): boolean {
    if (!session?.cwd || !this.skipped.has(encodeProjectDir(session.cwd))) return false;
    return !this.store.state.projects[session.projectId ?? ''];
  }

  private row(sessionId: string): SessionRow | null {
    const parsed = SessionRow.safeParse(this.stmt.getSession.get(sessionId));
    return parsed.success ? parsed.data : null;
  }

  private projectOf(cwd: string | null): string | null {
    return cwd === null ? null : deepestProject(this.store.state.projects, cwd);
  }

  /** Projects come and go: a transcript follows the project its folder belongs to now. */
  private assignProjects(): void {
    const cwds = this.db
      .prepare('SELECT DISTINCT cwd FROM search_sessions WHERE cwd IS NOT NULL')
      .all();
    const update = this.db.prepare('UPDATE search_sessions SET project_id = ? WHERE cwd = ?');
    for (const row of cwds) {
      const cwd = String(row.cwd);
      update.run(this.projectOf(cwd), cwd);
    }
  }

  /** A forgotten project that is back on the board is indexed again. */
  private unskipReturned(): void {
    const paths = new Set(Object.values(this.store.state.projects).map((p) => p.path));
    const remove = this.db.prepare('DELETE FROM search_skipped WHERE dir = ?');
    for (const [dir, path] of this.skipped) {
      if (!paths.has(path)) continue;
      this.skipped.delete(dir);
      remove.run(dir);
    }
  }

  // Limits and clearing

  /** Applies the size limit now: the oldest sessions go, and aren't read again. */
  trim(): void {
    this.sinceTrim = 0;
    if (this.closed) return;
    const excess = this.size() - this.settings().maxBytes;
    if (excess <= 0) return;
    const oldest = this.db
      .prepare(
        `SELECT session_id, bytes FROM search_sessions WHERE messages > 0
         ORDER BY updated_at, session_id`,
      )
      .all();
    const ids: string[] = [];
    let freed = 0;
    for (const row of oldest) {
      ids.push(String(row.session_id));
      freed += Number(row.bytes) * STORED_PER_BYTE;
      if (freed >= excess) break;
    }
    this.db.exec('BEGIN');
    try {
      const floor = this.now();
      for (const id of ids) {
        this.stmt.dropText.run(id);
        this.stmt.dropMessages.run(id);
        this.stmt.evict.run(floor, id);
      }
      this.db.exec('COMMIT');
      this.trimmed += ids.length;
      this.log.debug({ sessions: ids.length }, 'trimmed the transcript index');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.log.warn({ err }, 'could not trim the transcript index');
    }
  }

  /** Empties the index; only what's said from now on is added. */
  clear(): void {
    this.setFloor(this.now());
    this.wipe();
    this.compact();
    void this.scan();
  }

  /** Empties the index and reads every transcript again. */
  rebuild(): void {
    this.setFloor(0);
    this.wipe();
    void this.scan();
  }

  private wipe(): void {
    this.generation += 1;
    this.live = new Map();
    this.queued = 0;
    this.trimmed = 0;
    this.sinceTrim = 0;
    this.db.exec(`
      BEGIN;
      DELETE FROM search_messages;
      DELETE FROM search_sessions;
      DROP TABLE search_fts;
      ${SEARCH_FTS_TABLE}
      COMMIT;
    `);
  }

  /** Gives deleted text's pages back, so it's gone from the file and not just unlisted. */
  private compact(): void {
    try {
      this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (err) {
      this.log.warn({ err }, 'could not compact the database');
    }
  }

  /**
   * Removes a project's sessions, and keeps its folders out of the index until it comes back.
   * Call before the project leaves the store.
   */
  forgetProject(project: { id: string; path: string }): void {
    this.flushLive();
    this.generation += 1;
    if (this.scanning) this.again = true;
    const rows = this.db
      .prepare(
        `SELECT session_id, cwd FROM search_sessions
         WHERE project_id = ? OR cwd = ? OR cwd LIKE ? ESCAPE '\\'`,
      )
      .all(project.id, project.path, `${likePrefix(project.path)}/%`);
    const dirs = new Set([encodeProjectDir(project.path)]);
    const skip = this.db.prepare(
      'INSERT OR REPLACE INTO search_skipped (dir, project_path) VALUES (?, ?)',
    );
    const drop = this.db.prepare('DELETE FROM search_sessions WHERE session_id = ?');
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const id = String(row.session_id);
        if (row.cwd !== null) dirs.add(encodeProjectDir(String(row.cwd)));
        this.stmt.dropText.run(id);
        this.stmt.dropMessages.run(id);
        drop.run(id);
      }
      for (const dir of dirs) {
        skip.run(dir, project.path);
        this.skipped.set(dir, project.path);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.log.warn({ err, projectId: project.id }, 'could not forget a project in the index');
    }
  }

  // Reading

  /**
   * About how much of `board.db` the index takes. Worked out from the text held rather than
   * measured: deleted rows only leave the full-text structures when they next merge, so a
   * measurement would still count what `trim` just dropped, and it would drop more.
   */
  size(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS text FROM search_sessions')
      .get();
    return Number(row?.text ?? 0) * STORED_PER_BYTE;
  }

  status(): SearchIndexStatus {
    this.flushLive();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(messages), 0) AS messages
         FROM search_sessions WHERE messages > 0`,
      )
      .get();
    return {
      indexing: this.scanning !== null,
      sessions: Number(row?.sessions ?? 0),
      messages: Number(row?.messages ?? 0),
      bytes: this.size(),
      maxBytes: this.settings().maxBytes,
      trimmed: this.trimmed,
      lastIndexedAt: this.lastIndexedAt,
    };
  }

  search(request: SearchRequest): SearchResponse {
    this.flushLive();
    const match = ftsQuery(request.q);
    if (match === null) return { hits: [], more: false };
    const sessions = Object.values(this.store.state.sessions);
    const clauses = ['search_fts MATCH ?'];
    const params: (string | number)[] = [match];
    const add = (clause: string, value: string | number | undefined) => {
      if (value === undefined) return;
      clauses.push(clause);
      params.push(value);
    };
    add('s.project_id = ?', request.projectId);
    add('COALESCE(m.ts, s.updated_at) >= ?', request.from);
    add('COALESCE(m.ts, s.updated_at) <= ?', request.to);
    const ids = (state: 'live' | 'archived') =>
      JSON.stringify(sessions.filter((s) => stateOf(s) === state).map((s) => s.id));
    if (request.status === 'live' || request.status === 'archived') {
      add('s.session_id IN (SELECT value FROM json_each(?))', ids(request.status));
    } else if (request.status === 'finished') {
      add('s.session_id NOT IN (SELECT value FROM json_each(?))', ids('live'));
      add('s.session_id NOT IN (SELECT value FROM json_each(?))', ids('archived'));
    }
    const sql = `
      SELECT m.session_id, m.message_id, m.kind, m.ts, s.project_id, s.cwd,
             s.custom_title, s.ai_title, s.first_prompt,
             snippet(search_fts, 0, '${HIT_OPEN}', '${HIT_CLOSE}', '…', ${SNIPPET_TOKENS}) AS snippet
      FROM search_fts
      JOIN search_messages m ON m.id = search_fts.rowid
      JOIN search_sessions s ON s.session_id = m.session_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY search_fts.rank
      LIMIT ${MATCH_WINDOW}`;

    let rows: unknown[];
    try {
      rows = this.db.prepare(sql).all(...params);
    } catch (err) {
      this.log.debug({ err }, 'search failed');
      return { hits: [], more: false };
    }
    const hits: SearchHit[] = [];
    const perSession = new Map<string, number>();
    const shown = new Set<string>();
    let more = false;
    for (const raw of rows) {
      const row = HitRow.safeParse(raw);
      if (!row.success) continue;
      const count = perSession.get(row.data.session_id) ?? 0;
      // A follow-up said twice in a session reads the same twice in a list.
      const repeat = `${row.data.session_id}\n${row.data.snippet}`;
      if (count >= HITS_PER_SESSION || shown.has(repeat)) continue;
      if (hits.length >= request.limit) {
        more = true;
        break;
      }
      perSession.set(row.data.session_id, count + 1);
      shown.add(repeat);
      const session = this.store.state.sessions[row.data.session_id];
      hits.push({
        sessionId: row.data.session_id,
        messageId: row.data.message_id,
        kind: row.data.kind,
        ts: row.data.ts,
        ...this.describe(row.data, session),
        snippet: snippetRuns(row.data.snippet),
      });
    }
    return { hits, more };
  }

  /** The stored session as results show it; the board's own record wins while it has one. */
  private describe(
    row: Pick<
      z.infer<typeof HitRow>,
      'project_id' | 'cwd' | 'custom_title' | 'ai_title' | 'first_prompt'
    >,
    session: ClaudeSession | undefined,
  ): Pick<SearchHit, 'title' | 'projectId' | 'projectName' | 'state'> {
    const projectId = session?.projectId ?? row.project_id;
    const project = projectId === null ? undefined : this.store.state.projects[projectId];
    return {
      // "Claude N" names nothing here: anything said about the session beats it.
      title:
        (session?.boardTitle || session?.customTitle || session?.aiTitle) ??
        row.custom_title ??
        row.ai_title ??
        row.first_prompt ??
        (session ? sessionDisplayName(session) : 'Untitled session'),
      projectId: project?.id ?? null,
      projectName: project?.name ?? folderName(row.cwd),
      state: session ? stateOf(session) : 'finished',
    };
  }

  /** The messages around `around` (or the last ones), or null when the transcript is gone. */
  async transcript(
    sessionId: string,
    around: string | undefined,
  ): Promise<SearchTranscriptResponse | null> {
    this.flushLive();
    const row = this.row(sessionId);
    const session = this.store.state.sessions[sessionId];
    if (!row && !session) return null;
    const source = this.readMessages
      ? this.readMessages(sessionId)
      : this.fileMessages(this.pathFor(sessionId, row, session));
    if (source === null) return null;
    const { messages, clipped } = await messageWindow(source, around, TRANSCRIPT_WINDOW);
    if (messages.length === 0) return null;
    const stored = row ?? {
      project_id: null,
      cwd: session?.cwd ?? null,
      custom_title: null,
      ai_title: null,
      first_prompt: null,
    };
    return {
      sessionId,
      ...this.describe(stored, session),
      cwd: session?.cwd ?? row?.cwd ?? null,
      clipped,
      messages,
    };
  }

  /** The transcript's file, only ever one under `<config>/projects`. */
  private pathFor(
    sessionId: string,
    row: SessionRow | null,
    session: ClaudeSession | undefined,
  ): string | null {
    if (this.configDir === null) return null;
    const root = join(resolve(this.configDir), 'projects');
    const cwd = row?.cwd ?? session?.cwd ?? null;
    const path =
      row?.path ??
      session?.transcriptPath ??
      (cwd === null ? null : join(root, encodeProjectDir(cwd), `${sessionId}.jsonl`));
    if (path === null) return null;
    const full = resolve(path);
    return full.endsWith('.jsonl') && isInside(root, full) ? full : null;
  }

  private fileMessages(path: string | null): AsyncIterable<ChatMessage> | null {
    return path === null ? null : readTranscript(path, this.log);
  }

  close(): void {
    if (this.closed) return;
    this.flushLive();
    this.closed = true;
    this.generation += 1;
    this.stopFollowing?.();
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Waits out a running pass, so the database can close under it. */
  async idle(): Promise<void> {
    await this.scanning;
  }
}

/** Every normalized message of a transcript file, read in bounded steps. */
async function* readTranscript(
  path: string,
  log: Pick<FastifyBaseLogger, 'debug'>,
): AsyncGenerator<ChatMessage> {
  const tail = new JsonlTail(path);
  const seen = new Set<string>();
  let limit = READ_BYTES;
  for (;;) {
    const at = tail.offset;
    const { lines } = await tail.read(limit);
    for (const line of lines) {
      const entry = parseTranscriptLine(line);
      if (entry === null) {
        log.debug({}, 'skipped bad transcript line');
        continue;
      }
      for (const message of normalizeEntry(entry)) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        yield message;
      }
    }
    if (tail.offset !== at) {
      limit = READ_BYTES;
      continue;
    }
    if (lines.length > 0 || limit >= 2 ** 40) return;
    const size = await stat(path).then(
      (info) => info.size,
      () => 0,
    );
    if (at + limit >= size) return;
    limit *= 2;
  }
}

/** Up to `size` messages centered on `around`; the last `size` when it isn't there. */
export async function messageWindow(
  source: Iterable<ChatMessage> | AsyncIterable<ChatMessage>,
  around: string | undefined,
  size: number,
): Promise<{ messages: ChatMessage[]; clipped: boolean }> {
  const half = Math.floor(size / 2);
  let messages: ChatMessage[] = [];
  let clipped = false;
  let after = -1;
  for await (const message of source) {
    if (after >= half) {
      clipped = true;
      break;
    }
    messages.push(message);
    if (after >= 0) {
      after += 1;
    } else if (message.id === around) {
      after = 0;
      if (messages.length > half + 1) {
        messages = messages.slice(-(half + 1));
        clipped = true;
      }
    } else if (messages.length > size) {
      messages.shift();
      clipped = true;
    }
  }
  return { messages, clipped };
}

/** The text a message adds to the index, or null when it has none to add. */
export function searchableText(message: ChatMessage, includeTools: boolean): string | null {
  let text: string;
  switch (message.kind) {
    case 'user':
      if (message.meta) return null;
      text = message.text;
      break;
    case 'assistant':
      text = message.text;
      break;
    case 'tool_use':
      if (!includeTools) return null;
      text = `${message.name} ${JSON.stringify(message.input) ?? ''}`;
      break;
    case 'tool_result':
      if (!includeTools) return null;
      text = message.text;
      break;
    default:
      return null;
  }
  const body = text.slice(0, MAX_BODY).replace(HIT_MARKS, ' ');
  return body.trim() === '' ? null : body;
}

/**
 * The user's words as an FTS5 query, never its syntax: every word, or `"quoted phrase"`, is a
 * quoted string, all must match, and the last word matches as a prefix while it's being typed.
 */
export function ftsQuery(input: string): string | null {
  const terms: { text: string; phrase: boolean }[] = [];
  for (const [, phrase, word] of input.matchAll(/"([^"]*)"?|([^\s"]+)/g)) {
    const text = phrase ?? word ?? '';
    if (/[\p{L}\p{N}]/u.test(text)) terms.push({ text, phrase: phrase !== undefined });
  }
  if (terms.length === 0) return null;
  return terms
    .map(({ text, phrase }, index) => {
      const quoted = `"${text.replaceAll('"', '""')}"`;
      return index === terms.length - 1 && !phrase ? `${quoted}*` : quoted;
    })
    .join(' ');
}

/** Splits a marked snippet into runs, with its line breaks flattened. */
export function snippetRuns(snippet: string): SearchRun[] {
  const runs: SearchRun[] = [];
  for (const [index, part] of snippet.split(/|/).entries()) {
    const text = part.replace(/\s+/g, ' ');
    if (text !== '') runs.push({ text, hit: index % 2 === 1 });
  }
  return runs;
}

function stateOf(session: ClaudeSession): SearchHit['state'] {
  if (isArchivedSession(session)) return 'archived';
  return session.status.kind === 'ended' ? 'finished' : 'live';
}

function liveFacts(session: ClaudeSession | undefined, now: number): SessionFacts {
  return {
    projectId: session?.projectId ?? null,
    cwd: session?.cwd ?? null,
    path: null,
    customTitle: session?.boardTitle ?? session?.customTitle ?? null,
    aiTitle: session?.aiTitle ?? null,
    firstPrompt: session?.title ?? null,
    startedAt: session?.startedAt ?? null,
    updatedAt: session?.updatedAt ?? now,
  };
}

function folderName(cwd: string | null): string | null {
  return cwd?.split('/').filter(Boolean).pop() ?? null;
}

function likePrefix(path: string): string {
  return path.replace(/[\\%_]/g, (c) => `\\${c}`);
}

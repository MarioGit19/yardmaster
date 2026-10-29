import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ActivityEvent, ClaudeSession, Project } from '@yardmaster/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './app.js';
import type { ServerConfig } from './config.js';
import {
  ACTIVITY_RETENTION_MS,
  DB_FILE,
  Persistence,
  type PersistenceOptions,
  toSessionRecord,
} from './persistence.js';
import { BoardStore } from './store.js';
import { generateToken } from './token.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 15, 12);

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    path: `/home/dev/${id}`,
    name: id,
    accent: 3,
    source: 'editor',
    git: null,
    createdAt: T0,
    lastActivityAt: null,
    ...overrides,
  };
}

function event(id: string, ts: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id,
    ts,
    kind: 'tool.start',
    projectId: 'acme-shop',
    sessionId: null,
    terminalId: null,
    execId: null,
    summary: `event ${id}`,
    data: { tool: 'Bash' },
    ...overrides,
  };
}

let home: string;
let clock: number;
const open: Persistence[] = [];

function openDb(options: PersistenceOptions = {}): Persistence {
  const db = new Persistence({ home, now: () => clock, pruneIntervalMs: 0, ...options });
  open.push(db);
  return db;
}

/** Closes `db` and reopens the same file, as a server restart would. */
function restart(db: Persistence, options: PersistenceOptions = {}): Persistence {
  db.close();
  return openDb(options);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yardmaster-db-'));
  clock = T0;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const db of open.splice(0)) db.close();
  await rm(home, { recursive: true, force: true });
});

describe('Persistence', () => {
  it('creates board.db under the home dir, readable only by the owner', async () => {
    const nested = join(home, 'nested', '.yardmaster');
    const db = openDb({ home: nested });
    expect(db.path).toBe(join(nested, DB_FILE));
    expect((await stat(db.path)).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it('tightens a board.db and its WAL files left readable by others', async () => {
    const path = join(home, DB_FILE);
    await writeFile(path, '', { mode: 0o644 });
    await writeFile(`${path}-wal`, '', { mode: 0o644 });
    await chmod(path, 0o644);
    await chmod(`${path}-wal`, 0o644);
    openDb({ home });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600);
  });

  it('persists projects across a restart, including deletes', () => {
    let db = openDb();
    db.saveProject(project('acme-shop'));
    db.saveProject(project('orbit-api'));
    db.saveProject(project('acme-shop', { name: 'Acme Shop', lastActivityAt: T0 + 5 }));
    db.deleteProject('orbit-api');
    db = restart(db);
    expect(db.loadProjects()).toEqual([
      project('acme-shop', { name: 'Acme Shop', lastActivityAt: T0 + 5 }),
    ]);
  });

  it('persists session metadata only', () => {
    let db = openDb();
    const store = new BoardStore({ autoFlush: false, now: () => clock });
    db.attach(store);
    store.upsertSession({
      id: 'b3f0c2a1-0000-4000-8000-000000000001',
      projectId: 'acme-shop',
      cwd: '/home/dev/acme-shop',
      title: 'Fix checkout',
      lastAssistantText: 'Done, the tests pass.',
      todos: [{ content: 'write tests', status: 'completed', activeForm: null }],
    });
    store.setSessionStatus('b3f0c2a1-0000-4000-8000-000000000001', { kind: 'ended' }, T0 + 10);
    store.flush();
    db = restart(db);

    const [session, ...rest] = db.loadSessions();
    expect(rest).toEqual([]);
    expect(session).toMatchObject({
      id: 'b3f0c2a1-0000-4000-8000-000000000001',
      projectId: 'acme-shop',
      title: 'Fix checkout',
      endedAt: T0 + 10,
    });
    expect(session).not.toHaveProperty('lastAssistantText');
    expect(session).not.toHaveProperty('todos');
    expect(session).not.toHaveProperty('status');
  });

  it('remembers whether a board session was running, for a restart', () => {
    const store = new BoardStore();
    const base = { origin: 'board' as const, projectId: 'p', status: { kind: 'idle' as const } };
    const runOf = (status: ClaudeSession['status'], origin: 'board' | 'terminal' = 'board') =>
      toSessionRecord(store.upsertSession({ ...base, id: 's', origin, status })).run ?? null;
    expect(runOf({ kind: 'idle' })).toBe('idle');
    expect(runOf({ kind: 'tool', tool: 'Bash', toolUseId: null })).toBe('turn');
    expect(runOf({ kind: 'interrupted', turnRunning: true })).toBe('turn');
    expect(runOf({ kind: 'interrupted', turnRunning: false })).toBe('idle');
    expect(runOf({ kind: 'ended' })).toBeNull();
    expect(runOf({ kind: 'working' }, 'terminal')).toBeNull();
  });

  it('mirrors store project changes and keeps sessions after removal', () => {
    let db = openDb();
    const store = new BoardStore({ autoFlush: false, now: () => clock });
    const detach = db.attach(store);
    store.upsertProject(project('acme-shop'));
    store.upsertProject(project('orbit-api'));
    store.upsertSession({ id: 'sess-1', projectId: 'acme-shop' });
    store.flush();
    store.touchProject('acme-shop', T0 + 99);
    store.removeProject('orbit-api');
    store.removeSession('sess-1');
    store.flush();
    detach();
    store.upsertProject(project('ignored'));
    store.flush();
    db = restart(db);

    expect(db.loadProjects()).toEqual([project('acme-shop', { lastActivityAt: T0 + 99 })]);
    expect(db.loadSessions().map((s) => s.id)).toEqual(['sess-1']);
  });

  it('persists settings immediately, with JSON values and deletes', () => {
    let db = openDb();
    db.setSetting('motion', 'reduced');
    db.setSetting('redact', true);
    db.setSetting('layout', { columns: 3, pinned: ['acme-shop'] });
    db.setSetting('redact', undefined);
    expect(() => db.setSetting('', 1)).toThrow(RangeError);
    db = restart(db);
    expect(db.loadSettings()).toEqual({
      motion: 'reduced',
      layout: { columns: 3, pinned: ['acme-shop'] },
    });
  });

  it('writes activity in batches after a delay', () => {
    vi.useFakeTimers();
    const db = openDb({ writeDelayMs: 250 });
    db.recordActivity(event('e1', T0));
    db.recordActivity(event('e2', T0 + 1));

    const reader = new DatabaseSync(db.path);
    const count = () => Number(reader.prepare('SELECT count(*) AS n FROM activity').get()?.n);
    expect(count()).toBe(0);
    vi.advanceTimersByTime(250);
    expect(count()).toBe(2);
    reader.close();
  });

  it('flushes as soon as a batch is full', () => {
    vi.useFakeTimers();
    const db = openDb({ maxBatch: 3 });
    const reader = new DatabaseSync(db.path);
    const count = () => Number(reader.prepare('SELECT count(*) AS n FROM activity').get()?.n);
    for (let i = 0; i < 3; i++) db.recordActivity(event(`e${i}`, T0 + i));
    expect(count()).toBe(3);
    reader.close();
  });

  it('persists activity across a restart and queries it in time order', () => {
    let db = openDb();
    db.recordActivity(event('e2', T0 + 2, { projectId: 'orbit-api' }));
    db.recordActivity(event('e1', T0 + 1, { data: { nested: { ok: true } } }));
    db.recordActivity(event('e3', T0 + 3, { sessionId: 'sess-1' }));
    db.recordActivity(event('e1', T0 + 1)); // duplicate id is ignored
    db = restart(db);

    expect(db.listActivity().map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(db.listActivity()[0]).toEqual(event('e1', T0 + 1, { data: { nested: { ok: true } } }));
    expect(db.listActivity({ projectId: 'orbit-api' }).map((e) => e.id)).toEqual(['e2']);
    expect(db.listActivity({ sessionId: 'sess-1' }).map((e) => e.id)).toEqual(['e3']);
    expect(db.listActivity({ since: T0 + 2 }).map((e) => e.id)).toEqual(['e2', 'e3']);
    expect(db.listActivity({ until: T0 + 2 }).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(db.listActivity({ limit: 2 }).map((e) => e.id)).toEqual(['e2', 'e3']);
  });

  it('includes unflushed events in queries', () => {
    const db = openDb({ writeDelayMs: 60_000 });
    db.recordActivity(event('e1', T0));
    expect(db.listActivity().map((e) => e.id)).toEqual(['e1']);
  });

  it('prunes activity older than 7 days, on demand and on open', () => {
    let db = openDb();
    db.recordActivity(event('old', T0 - ACTIVITY_RETENTION_MS - 1));
    db.recordActivity(event('edge', T0 - ACTIVITY_RETENTION_MS));
    db.recordActivity(event('new', T0 - DAY));
    expect(db.prune()).toBe(1);
    expect(db.listActivity().map((e) => e.id)).toEqual(['edge', 'new']);

    clock = T0 + DAY;
    db = restart(db);
    expect(db.listActivity().map((e) => e.id)).toEqual(['new']);
  });

  it('applies a shorter retention right away', () => {
    const db = openDb();
    db.recordActivity(event('old', T0 - 3 * DAY));
    db.recordActivity(event('new', T0 - DAY / 2));
    db.setRetention(DAY);
    expect(db.retention).toBe(DAY);
    expect(db.listActivity().map((e) => e.id)).toEqual(['new']);
    expect(() => db.setRetention(0)).toThrow(RangeError);
  });

  it('prunes on the hourly timer', () => {
    vi.useFakeTimers();
    const db = openDb({ pruneIntervalMs: 60 * 60 * 1000 });
    db.recordActivity(event('e1', T0 - DAY));
    db.flush();
    clock = T0 + 7 * DAY;
    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(db.listActivity()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(db.listActivity()).toHaveLength(0);
  });

  it('skips corrupt rows on load instead of throwing', () => {
    let db = openDb();
    db.saveProject(project('acme-shop'));
    db.setSetting('motion', 'full');
    db.close();

    const raw = new DatabaseSync(join(home, DB_FILE));
    raw.prepare('INSERT INTO projects (id, data, updated_at) VALUES (?, ?, ?)').run('bad', '{', 0);
    raw
      .prepare('INSERT INTO projects (id, data, updated_at) VALUES (?, ?, ?)')
      .run('invalid', JSON.stringify({ id: 'invalid' }), 0);
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('broken', 'not json');
    raw.close();

    const warn = vi.fn();
    db = openDb({ logger: { warn, error: vi.fn() } });
    expect(db.loadProjects().map((p) => p.id)).toEqual(['acme-shop']);
    expect(db.loadSettings()).toEqual({ motion: 'full' });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('skips activity whose data cannot be serialized', () => {
    const warn = vi.fn();
    const db = openDb({ logger: { warn, error: vi.fn() } });
    db.recordActivity(event('bad', T0, { data: { n: 1n } }));
    db.recordActivity(event('good', T0 + 1));
    expect(db.listActivity().map((e) => e.id)).toEqual(['good']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses a database from a newer schema', () => {
    openDb().close();
    const raw = new DatabaseSync(join(home, DB_FILE));
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    expect(() => openDb()).toThrow(/newer/);
  });

  it('flushes pending writes on close', () => {
    let db = openDb({ writeDelayMs: 60_000 });
    db.saveProject(project('acme-shop'));
    db.recordActivity(event('e1', T0));
    db = restart(db);
    expect(db.loadProjects()).toHaveLength(1);
    expect(db.listActivity()).toHaveLength(1);
  });
});

describe('server boot', () => {
  const config = (): ServerConfig => ({
    port: 4317,
    host: '127.0.0.1',
    home,
    logLevel: 'silent',
    devOrigins: [],
  });
  const token = generateToken();

  it('loads projects and settings from YARDMASTER_HOME across restarts', async () => {
    let app = await buildServer(config(), { token, processes: false });
    expect(app.store.state.projects).toEqual({});
    app.store.upsertProject(project('acme-shop'));
    app.persistence.setSetting('motion', 'off');
    await app.close();

    app = await buildServer(config(), { token, processes: false });
    expect(app.store.state.projects).toEqual({ 'acme-shop': project('acme-shop') });
    expect(app.settings).toEqual({
      motion: 'off',
      // Signed-in browsers, and a seal of the token they belong to.
      'auth.sessions': [],
      'auth.sessionsToken': expect.any(String),
    });
    app.store.removeProject('acme-shop');
    await app.close();

    app = await buildServer(config(), { token, processes: false });
    expect(app.store.state.projects).toEqual({});
    await app.close();
  });
});

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectIdFromPath } from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../app.js';
import type { ServerConfig } from '../config.js';
import { localInject } from '../local-channel.test-helpers.js';
import { BoardStore } from '../store.js';
import { generateToken } from '../token.js';
import { FIXTURE_CWD, FIXTURE_SESSION_ID, hookFixture } from './fixtures.test-helpers.js';
import { HOOK_ROUTE, HookIngest, parseClaudePid } from './hook-ingest.js';

const config: ServerConfig = {
  port: 4317,
  host: '127.0.0.1',
  home: '/home/dev/.yardmaster',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const host = '127.0.0.1:4317';

let app: FastifyInstance | undefined;
let tmp: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** Posts like the hook script: over the board's socket. */
function post(body: unknown, headers: Record<string, string> = {}) {
  return localInject(app as FastifyInstance, {
    method: 'POST',
    url: HOOK_ROUTE,
    headers: { 'x-yardmaster-token': token, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

/** The route applies events after replying. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await app?.hookIngest.idle();
}

describe(`POST ${HOOK_ROUTE}`, () => {
  it('requires the token', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    const res = await localInject(app, {
      method: 'POST',
      url: HOOK_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(hookFixture('session-start')),
    });
    expect(res.statusCode).toBe(401);
    // A token sent over TCP is refused: whatever holds the port may not be the board.
    const tcp = await app.inject({
      method: 'POST',
      url: HOOK_ROUTE,
      headers: { host, 'x-yardmaster-token': token, 'content-type': 'application/json' },
      payload: JSON.stringify(hookFixture('session-start')),
    });
    expect(tcp.statusCode).toBe(403);
    await settled();
    expect(app.store.state.sessions).toEqual({});
    expect(app.hookStats.received).toBe(0);
  });

  it('accepts the old header names on the socket, never over TCP', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    const legacy = {
      'x-cboard-token': token,
      'x-cboard-claude-pid': '4321',
      'content-type': 'application/json',
    };
    const payload = JSON.stringify(hookFixture('session-start'));
    const tcp = await app.inject({
      method: 'POST',
      url: HOOK_ROUTE,
      headers: { host, ...legacy },
      payload,
    });
    expect(tcp.statusCode).toBe(403);
    const res = await localInject(app, {
      method: 'POST',
      url: HOOK_ROUTE,
      headers: legacy,
      payload,
    });
    expect(res.statusCode).toBe(204);
    await settled();
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]).toMatchObject({ claudePid: 4321 });
  });

  it('replies 204 and drives a session through a turn', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });

    const start = await post(hookFixture('session-start'), { 'x-yardmaster-claude-pid': '4321' });
    expect(start.statusCode).toBe(204);
    expect(start.body).toBe('');
    await settled();

    const projectId = projectIdFromPath(FIXTURE_CWD);
    expect(app.store.state.projects[projectId]).toMatchObject({
      path: FIXTURE_CWD,
      name: 'acme-shop',
      source: 'hook',
      git: null,
    });
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]).toMatchObject({
      origin: 'terminal',
      projectId,
      status: { kind: 'idle' },
      model: 'claude-sonnet-5-5',
      claudePid: 4321,
    });

    await post(hookFixture('user-prompt-submit'));
    await post(hookFixture('pre-tool-use-bash'));
    await settled();
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]).toMatchObject({
      title: 'Refactor the cart totals into a pure function',
      status: { kind: 'tool', tool: 'Bash' },
      currentTool: { tool: 'Bash', summary: 'pnpm test', status: 'running' },
      claudePid: 4321,
    });

    await post(hookFixture('post-tool-use', { tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv' }));
    await post(hookFixture('stop'));
    await settled();
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]).toMatchObject({
      status: { kind: 'idle' },
      currentTool: null,
      lastAssistantText: 'Cart totals are now computed in one place.',
    });

    await post(hookFixture('stop-failure'));
    await settled();
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]?.status).toEqual({
      kind: 'error',
      message: 'Rate limit reached',
      reason: 'rate_limit',
    });

    expect(app.hookStats.received).toBe(6);
    expect(app.hookStats.lastAt).toEqual(expect.any(Number));
  });

  it('records activity and the session row', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    await post(hookFixture('session-start'));
    await post(
      hookFixture('pre-tool-use-edit', {
        tool_input: { file_path: 'a.ts', content: 'x'.repeat(50_000) },
      }),
    );
    await settled();
    app.store.flush();

    const projectId = projectIdFromPath(FIXTURE_CWD);
    const activity = app.persistence.listActivity({ sessionId: FIXTURE_SESSION_ID });
    expect(activity.map((event) => event.kind)).toEqual(['session.start', 'tool.start']);
    expect(activity.every((event) => event.projectId === projectId)).toBe(true);
    const input = activity[1]?.data.toolInput as { content: string };
    expect(input.content.length).toBeLessThanOrEqual(1_000);

    app.persistence.flush();
    expect(app.persistence.loadSessions().map((session) => session.id)).toEqual([
      FIXTURE_SESSION_ID,
    ]);
  });

  it('maps a cwd inside a known project to that project', async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'yardmaster-hooks-')));
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    const outer = projectIdFromPath(tmp);
    const inner = projectIdFromPath(join(tmp, 'packages'));
    for (const [id, path] of [
      [outer, tmp],
      [inner, join(tmp, 'packages')],
    ] as const) {
      app.store.upsertProject({
        id,
        path,
        name: 'demo',
        accent: 0,
        source: 'editor',
        git: null,
        createdAt: 1,
        lastActivityAt: null,
      });
    }

    await post(hookFixture('session-start', { cwd: join(tmp, 'packages', 'web', 'src') }));
    await post(hookFixture('session-start', { session_id: 'other', cwd: join(tmp, 'docs') }));
    await post(hookFixture('session-start', { session_id: 'sibling', cwd: `${tmp}-other` }));
    await settled();

    expect(app.store.state.sessions[FIXTURE_SESSION_ID]?.projectId).toBe(inner);
    expect(app.store.state.sessions.other?.projectId).toBe(outer);
    expect(app.store.state.sessions.sibling?.projectId).toBe(projectIdFromPath(`${tmp}-other`));
    expect(app.store.state.projects[inner]?.lastActivityAt).toEqual(expect.any(Number));
  });

  it('moves a session to the project of its new folder', async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'yardmaster-hooks-')));
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    const inner = projectIdFromPath(join(tmp, 'packages'));
    app.store.upsertProject({
      id: inner,
      path: join(tmp, 'packages'),
      name: 'demo',
      accent: 0,
      source: 'editor',
      git: null,
      createdAt: 1,
      lastActivityAt: null,
    });

    await post(hookFixture('session-start', { cwd: tmp }));
    await post(hookFixture('cwd-changed', { cwd: tmp, new_cwd: join(tmp, 'packages') }));
    await settled();

    expect(app.store.state.sessions[FIXTURE_SESSION_ID]?.projectId).toBe(inner);
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]?.cwd).toBe(join(tmp, 'packages'));
  });

  it.each([
    ['permission-denied', 'permission.denied'],
    ['task-created', 'task.created'],
    ['task-completed', 'task.completed'],
    ['cwd-changed', 'cwd.changed'],
    ['notification-agent-needs-input', 'notification'],
    ['notification-agent-completed', 'notification'],
    ['notification-quota-fired', 'notification'],
    ['notification-quota-stale', 'notification'],
    ['notification-quota-disabled', 'notification'],
    ['stop-failure-auth', 'stop.failure'],
    ['stop-failure-billing', 'stop.failure'],
  ] as const)('applies %s and records it as %s', async (fixture, kind) => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    await post(hookFixture(fixture));
    await settled();
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]).toBeDefined();
    app.store.flush();
    const activity = app.persistence.listActivity({ sessionId: FIXTURE_SESSION_ID });
    expect(activity.map((event) => event.kind)).toContain(kind);
  });

  it('skips malformed payloads without failing the request', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    for (const body of [[1, 2], 'text', { hook_event_name: 'Stop' }, { session_id: '' }]) {
      expect((await post(body)).statusCode).toBe(204);
    }
    const bad = await localInject(app, {
      method: 'POST',
      url: HOOK_ROUTE,
      headers: { 'x-yardmaster-token': token, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    await settled();
    expect(app.store.state.sessions).toEqual({});
    expect(app.store.state.projects).toEqual({});

    await post(hookFixture('unknown-event'));
    await settled();
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]?.status).toEqual({
      kind: 'unknown',
      alive: true,
    });
  });

  it('refreshes git info after an edit', async () => {
    const run = vi.fn(async (_dir: string, args: readonly string[]) =>
      args[0] === 'status' ? '# branch.oid (initial)\0# branch.head main\0? new.ts\0' : '',
    );
    app = await buildServer(config, {
      token,
      dbPath: ':memory:',
      processes: false,
      git: { run, debounceMs: 0 },
    });
    await post(hookFixture('session-start'));
    await settled();
    expect(run).not.toHaveBeenCalled();
    await post(hookFixture('post-tool-use', { tool_name: 'Write' }));
    await settled();
    const projectId = projectIdFromPath(FIXTURE_CWD);
    await vi.waitFor(() =>
      expect(app?.store.state.projects[projectId]?.git).toMatchObject({ branch: 'main', dirty: 1 }),
    );
    expect(run).toHaveBeenCalledWith(FIXTURE_CWD, expect.arrayContaining(['status']));
  });

  it('counts but does not apply hooks in demo mode', async () => {
    app = await buildServer(config, { token, demo: { seed: 7 } });
    const before = Object.keys(app.store.state.sessions).length;
    await post(hookFixture('session-start'));
    await settled();
    expect(app.store.state.sessions[FIXTURE_SESSION_ID]).toBeUndefined();
    expect(Object.keys(app.store.state.sessions)).toHaveLength(before);
    expect(app.hookStats.received).toBe(1);
  });
});

describe('HookIngest', () => {
  it('applies events in arrival order even when path lookups resolve out of order', async () => {
    const store = new BoardStore({ autoFlush: false });
    const delays = [30, 0];
    const ingest = new HookIngest({
      store,
      logger: { warn: vi.fn(), debug: vi.fn() },
      resolvePath: (path) =>
        new Promise((resolve) => setTimeout(() => resolve(path), delays.shift() ?? 0)),
    });
    void ingest.enqueue(hookFixture('user-prompt-submit'), null);
    void ingest.enqueue(hookFixture('stop'), null);
    await ingest.idle();
    expect(store.state.sessions[FIXTURE_SESSION_ID]?.status).toEqual({ kind: 'idle' });
  });

  it('keeps going after a failing event', async () => {
    const store = new BoardStore({ autoFlush: false });
    const warn = vi.fn();
    const ingest = new HookIngest({
      store,
      logger: { warn, debug: vi.fn() },
      onActivity: () => {
        throw new Error('disk full');
      },
    });
    await ingest.enqueue(hookFixture('session-start'), null);
    expect(warn).toHaveBeenCalledOnce();
    await ingest.enqueue(hookFixture('user-prompt-submit'), null);
    expect(store.state.sessions[FIXTURE_SESSION_ID]?.status).toEqual({ kind: 'working' });
  });

  it('reports finished tools with their project', async () => {
    const store = new BoardStore({ autoFlush: false });
    const onToolDone = vi.fn();
    const ingest = new HookIngest({
      store,
      logger: { warn: vi.fn(), debug: vi.fn() },
      resolvePath: async (path) => path,
      onToolDone,
    });
    await ingest.enqueue(hookFixture('pre-tool-use-edit'), null);
    await ingest.enqueue(hookFixture('post-tool-use-failure'), null);
    expect(onToolDone).not.toHaveBeenCalled();
    await ingest.enqueue(hookFixture('post-tool-use', { tool_name: 'Edit' }), null);
    expect(onToolDone).toHaveBeenCalledExactlyOnceWith('Edit', projectIdFromPath(FIXTURE_CWD));
  });

  it('leaves the project empty for a relative cwd', async () => {
    const store = new BoardStore({ autoFlush: false });
    const ingest = new HookIngest({ store, logger: { warn: vi.fn(), debug: vi.fn() } });
    await ingest.enqueue(hookFixture('session-start', { cwd: 'acme-shop' }), null);
    expect(store.state.sessions[FIXTURE_SESSION_ID]?.projectId).toBeNull();
    expect(store.state.projects).toEqual({});
  });
});

describe('parseClaudePid', () => {
  it.each([
    ['4321', 4321],
    [' 77 ', 77],
    ['0', null],
    ['-5', null],
    ['12abc', null],
    ['99999999999', null],
    [undefined, null],
    [['1', '2'], null],
  ] as const)('%j -> %j', (header, expected) => {
    expect(parseClaudePid(header as string | string[] | undefined)).toBe(expected);
  });
});

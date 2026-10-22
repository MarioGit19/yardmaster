import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Approval,
  AwayStatusResponse,
  PermissionRequestOutput,
  type ServerToUi,
} from '@c-board/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../app.js';
import type { ServerConfig } from '../config.js';
import { memoryHookSettings } from '../settings-routes.js';
import { BoardStore } from '../store.js';
import { generateToken } from '../token.js';
import { AWAY_ROUTE, AwayApprovals, PERMISSION_ROUTE } from './away.js';
import { FIXTURE_SESSION_ID, hookFixture } from './fixtures.test-helpers.js';
import { HookIngest } from './hook-ingest.js';

const host = '127.0.0.1:4317';
const silent = { warn: () => {}, debug: () => {} };

let app: FastifyInstance | undefined;
let home: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function boot(options: { demo?: boolean } = {}) {
  home = await mkdtemp(join(tmpdir(), 'cboard-away-'));
  const config: ServerConfig = {
    port: 4317,
    host: '127.0.0.1',
    home,
    logLevel: 'silent',
    devOrigins: [],
  };
  const token = generateToken();
  app = await buildServer(config, {
    token,
    dbPath: options.demo ? undefined : join(home, 'board.db'),
    processes: false,
    git: false,
    hookSettings: memoryHookSettings(),
    transcripts: { loadHistory: null },
    ...(options.demo ? { demo: true } : {}),
  });
  return { app, token };
}

function call(method: 'GET' | 'PUT' | 'POST', url: string, token: string | null, body?: unknown) {
  return (app as FastifyInstance).inject({
    method,
    url,
    headers: {
      host,
      ...(token ? { 'x-cboard-token': token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function pendingApproval(server: FastifyInstance): Promise<Approval> {
  await vi.waitFor(() => {
    expect(server.awayApprovals.size).toBe(1);
  });
  const approval = Object.values(server.store.state.approvals).find((a) => a.state === 'pending');
  if (!approval) throw new Error('no pending approval');
  return approval;
}

describe('away-mode routes', () => {
  it('need the token', async () => {
    await boot();
    expect((await call('GET', AWAY_ROUTE, null)).statusCode).toBe(401);
    expect((await call('POST', PERMISSION_ROUTE, null, {})).statusCode).toBe(401);
  });

  it('report away mode off by default and answer 204 at once', async () => {
    const { app: server, token } = await boot();
    const status = await call('GET', AWAY_ROUTE, token);
    expect(AwayStatusResponse.parse(status.json())).toEqual({ away: false, timeoutSec: 120 });
    expect(status.headers['cache-control']).toBe('no-store');

    const res = await call('POST', PERMISSION_ROUTE, token, hookFixture('permission-request'));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(server.store.state.approvals).toEqual({});
  });

  it('turns on through the settings and validates the timeout', async () => {
    const { token } = await boot();
    const put = await call('PUT', '/api/settings', token, { awayMode: true, awayTimeoutSec: 60 });
    expect(put.json()).toMatchObject({ awayMode: true, awayTimeoutSec: 60 });
    expect((await call('GET', AWAY_ROUTE, token)).json()).toEqual({ away: true, timeoutSec: 60 });
    for (const awayTimeoutSec of [5, 301, 12.5]) {
      expect((await call('PUT', '/api/settings', token, { awayTimeoutSec })).statusCode).toBe(400);
    }
  });

  it('holds the request as a hook approval until the board allows it', async () => {
    const { app: server, token } = await boot();
    await call('PUT', '/api/settings', token, { awayMode: true });
    const response = call('POST', PERMISSION_ROUTE, token, hookFixture('permission-request'));

    const approval = await pendingApproval(server);
    expect(approval).toMatchObject({
      sessionId: FIXTURE_SESSION_ID,
      source: 'hook',
      tool: 'Bash',
      input: { command: 'rm -rf dist' },
      state: 'pending',
    });
    expect(approval.suggestions).toHaveLength(1);
    expect(server.store.state.sessions[FIXTURE_SESSION_ID]?.status).toEqual({
      kind: 'waiting_permission',
      approvalId: approval.id,
    });

    expect(server.awayApprovals.decide({ approvalId: approval.id, decision: 'allow' })).toEqual({
      ok: true,
    });
    const res = await response;
    expect(res.statusCode).toBe(200);
    expect(PermissionRequestOutput.parse(res.json())).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(server.store.state.approvals[approval.id]?.state).toBe('allowed');
    expect(server.store.state.sessions[FIXTURE_SESSION_ID]?.status).toMatchObject({
      kind: 'tool',
      tool: 'Bash',
    });
  });

  it('returns the suggestions for "Always allow" and the reason for a denial', async () => {
    const { app: server, token } = await boot();
    await call('PUT', '/api/settings', token, { awayMode: true });

    const always = call('POST', PERMISSION_ROUTE, token, hookFixture('permission-request'));
    const first = await pendingApproval(server);
    server.awayApprovals.decide({ approvalId: first.id, decision: 'allowAlways' });
    expect((await always).json().hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'rm -rf dist' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    });

    const deny = call('POST', PERMISSION_ROUTE, token, hookFixture('permission-request'));
    const second = await pendingApproval(server);
    server.awayApprovals.decide({
      approvalId: second.id,
      decision: 'deny',
      reason: 'Not on main',
    });
    expect((await deny).json().hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'Not on main',
    });
    expect(server.store.state.sessions[FIXTURE_SESSION_ID]?.status).toEqual({ kind: 'working' });
    expect(server.awayApprovals.decide({ approvalId: second.id, decision: 'allow' })).toEqual({
      ok: false,
      error: 'unknown_approval',
    });
  });

  it('answers 204 for a malformed request, and in demo mode', async () => {
    const { token } = await boot();
    await call('PUT', '/api/settings', token, { awayMode: true });
    const bad = await call('POST', PERMISSION_ROUTE, token, {
      hook_event_name: 'PermissionRequest',
    });
    expect(bad.statusCode).toBe(204);
    await app?.close();
    app = undefined;

    const demo = await boot({ demo: true });
    await call('PUT', '/api/settings', demo.token, { awayMode: true });
    const res = await call('POST', PERMISSION_ROUTE, demo.token, hookFixture('permission-request'));
    expect(res.statusCode).toBe(204);
  });

  it('lets waiting hooks fall back to the terminal when the board stops', async () => {
    const { app: server, token } = await boot();
    await call('PUT', '/api/settings', token, { awayMode: true });
    const response = call('POST', PERMISSION_ROUTE, token, hookFixture('permission-request'));
    await pendingApproval(server);
    await server.close();
    app = undefined;
    expect((await response).statusCode).toBe(204);
  });
});

describe('AwayApprovals', () => {
  function setup(timeoutSec = 30) {
    const store = new BoardStore();
    const messages: ServerToUi[] = [];
    const ingest = new HookIngest({ store, logger: silent, resolvePath: async (p) => p });
    const away = new AwayApprovals({
      store,
      ingest,
      logger: silent,
      status: () => ({ away: true, timeoutSec }),
      onMessage: (message) => messages.push(message),
    });
    return { store, away, messages };
  }

  it('expires on timeout with no decision, back to the terminal prompt', async () => {
    // A fraction of a second: the class takes any timeout, the settings route validates it.
    const { store, away, messages } = setup(0.2);
    const decision = away.request(
      hookFixture('permission-request'),
      null,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(away.size).toBe(1));
    const [approval] = Object.values(store.state.approvals);
    expect(approval?.expiresAt).toBe((approval?.createdAt ?? 0) + 200);
    expect(await decision).toBeNull();
    expect(away.size).toBe(0);
    expect(store.state.approvals[approval?.id ?? '']).toMatchObject({
      state: 'expired',
      reason: 'Timed out',
    });
    expect(store.state.sessions[FIXTURE_SESSION_ID]?.status).toEqual({
      kind: 'waiting_permission',
      approvalId: null,
    });
    expect(messages.map((m) => m.type)).toEqual(['approval.new', 'approval.resolved']);
  });

  it('expires when the hook goes away', async () => {
    const { store, away } = setup();
    const controller = new AbortController();
    const decision = away.request(hookFixture('permission-request'), null, controller.signal);
    await vi.waitFor(() => expect(away.size).toBe(1));
    controller.abort();
    expect(await decision).toBeNull();
    expect(Object.values(store.state.approvals)[0]).toMatchObject({
      state: 'expired',
      reason: 'Answered in the terminal',
    });
  });
});

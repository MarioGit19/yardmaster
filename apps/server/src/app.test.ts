import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { projectIdFromPath, ServerStatus, SessionHistoryResponse } from '@c-board/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { type BuildOptions, buildServer, startServer } from './app.js';
import { MessageQueue } from './claude/runner.js';
import type { ServerConfig } from './config.js';
import { toSessionRecord } from './persistence.js';
import { generateToken } from './token.js';

const config: ServerConfig = {
  port: 4317,
  host: '127.0.0.1',
  home: '/home/dev/.c-board',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const host = '127.0.0.1:4317';

let app: FastifyInstance | undefined;
let tmpHome: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  tmpHome = undefined;
});

describe('server', () => {
  it('GET /api/health returns ok and the package version', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ ok: true, version: pkg.version });
  });

  it('GET /api/status needs auth and reports editors and hook stats', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    const denied = await app.inject({ method: 'GET', url: '/api/status', headers: { host } });
    expect(denied.statusCode).toBe(401);

    app.hookStats.received = 3;
    app.hookStats.lastAt = 1_800_000_000_000;
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host, 'x-cboard-token': token },
    });
    expect(res.statusCode).toBe(200);
    const body = ServerStatus.parse(res.json());
    expect(body).toMatchObject({
      ok: true,
      version: pkg.version,
      demo: false,
      editors: 0,
      hooks: { received: 3, lastAt: 1_800_000_000_000 },
    });
  });

  it('runs the process scanner outside demo mode', async () => {
    const run = async (file: string) =>
      file === 'ps'
        ? `${process.pid} 1 0.0 1024 node\n`
        : `p${process.pid}\ncnode\nn127.0.0.1:4999\n`;
    app = await buildServer(config, {
      token,
      dbPath: ':memory:',
      processes: { platform: 'darwin', run },
    });
    expect(app.processScanner).not.toBeNull();
    await app.processScanner?.scanProcesses();
    await app.processScanner?.scanPorts();
    expect(app.store.state.ports['127.0.0.1:4999']).toMatchObject({ pid: process.pid });
    await app.close();
    app = await buildServer(config, { token, demo: { seed: 1 } });
    expect(app.processScanner).toBeNull();
  });

  it('links sessions to terminals after each process sample', async () => {
    const run = async (file: string) =>
      file === 'ps' ? ' 4242 1 0.0 1024 -zsh\n 4300 4242 1.0 2048 claude\n' : '';
    app = await buildServer(config, {
      token,
      dbPath: ':memory:',
      processes: { platform: 'darwin', run },
      discovery: { listHistory: null, registryDir: '/nonexistent/c-board-test' },
    });
    expect(app.sessionLinker).not.toBeNull();
    app.store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', shellPid: 4242 });
    app.store.upsertSession({ id: 'sess-1', claudePid: 4300 });
    await app.processScanner?.scanProcesses();
    expect(app.store.state.sessions['sess-1']?.terminalId).toBe('t-1');
  });

  it('GET /api/projects/:id/sessions lists past sessions not on the board, with known token usage', async () => {
    const path = '/home/dev/acme-shop';
    const projectId = projectIdFromPath(path);
    const ids = [
      '0b6f6a52-3c1e-4d7a-9f0e-5a1b2c3d4e01',
      '0b6f6a52-3c1e-4d7a-9f0e-5a1b2c3d4e02',
      '0b6f6a52-3c1e-4d7a-9f0e-5a1b2c3d4e03',
    ];
    app = await buildServer(config, {
      token,
      dbPath: ':memory:',
      processes: false,
      git: false,
      discovery: {
        registryDir: '/nonexistent/c-board-test',
        listHistory: async (dir) =>
          dir === path
            ? [
                { sessionId: ids[2], summary: 'Oldest', lastModified: 100 },
                { sessionId: ids[0], customTitle: 'Live one', lastModified: 300 },
                { sessionId: ids[1], summary: 'Stored one', lastModified: 200 },
                { lastModified: 50 },
              ]
            : [],
      },
    });
    app.store.upsertProject({
      id: projectId,
      path,
      name: 'acme-shop',
      accent: 0,
      source: 'manual',
      git: null,
      createdAt: 1,
      lastActivityAt: null,
    });
    const usage = (input: number) => ({ input, output: 1, cacheRead: 0, cacheCreation: 0 });
    const live = app.store.upsertSession({ id: ids[0] as string, projectId, tokens: usage(10) });
    app.persistence.saveSession({
      ...toSessionRecord(live),
      id: ids[1] as string,
      tokens: usage(20),
    });

    const url = `/api/projects/${projectId}/sessions`;
    expect((await app.inject({ method: 'GET', url, headers: { host } })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { host, 'x-cboard-token': token },
    });
    expect(res.statusCode).toBe(200);
    const { sessions } = SessionHistoryResponse.parse(res.json());
    // The session on the board is listed there, not in History.
    expect(sessions.map((s) => [s.id, s.title, s.tokens?.input ?? null])).toEqual([
      [ids[1], 'Stored one', 20],
      [ids[2], 'Oldest', null],
    ]);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/projects/nope/sessions',
      headers: { host, 'x-cboard-token': token },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('serves a synthetic session history in demo mode', async () => {
    app = await buildServer(config, { token, demo: { seed: 1 } });
    const projectId = Object.keys(app.store.state.projects)[0];
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sessions`,
      headers: { host, 'x-cboard-token': token },
    });
    const { sessions } = SessionHistoryResponse.parse(res.json());
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    expect(sessions.every((s) => s.projectId === projectId)).toBe(true);
    const times = sessions.map((s) => s.updatedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('lists a board session as interrupted after a restart, and resumes the same id', async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'cboard-restart-'));
    const path = '/home/dev/acme-shop';
    const projectId = projectIdFromPath(path);
    const sessionId = '0b6f6a52-3c1e-4d7a-9f0e-5a1b2c3d4e0f';
    const calls: { options: Options; prompts: string[] }[] = [];
    // A scripted SDK: each query reports a running turn until it is closed.
    const query = ({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<SDKUserMessage>;
      options: Options;
    }) => {
      const call = { options, prompts: [] as string[] };
      calls.push(call);
      const outbox = new MessageQueue<unknown>();
      void (async () => {
        for await (const message of prompt) {
          call.prompts.push(String(message.message.content));
          outbox.push({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        }
      })();
      const generator = (async function* () {
        yield* outbox;
      })();
      return Object.assign(generator, { close: () => outbox.end() }) as unknown as Query;
    };
    const boot = () =>
      buildServer(config, {
        token,
        dbPath: join(tmpHome as string, 'board.db'),
        processes: false,
        git: false,
        discovery: { listHistory: null, registryDir: '/nonexistent/c-board-test' },
        transcripts: { loadHistory: async () => [], watchFile: () => async () => {} },
        runner: { query, newId: () => sessionId },
      } satisfies BuildOptions);

    app = await boot();
    app.store.upsertProject({
      id: projectId,
      path,
      name: 'acme-shop',
      accent: 0,
      source: 'manual',
      git: null,
      createdAt: 1,
      lastActivityAt: null,
    });
    const started = await app.sessionRunner.startSession({
      projectId,
      prompt: 'Fix the checkout',
      model: 'opus',
      permissionMode: 'acceptEdits',
    });
    expect(started).toEqual({ ok: true, sessionId });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(app.store.state.sessions[sessionId]?.status.kind).toBe('working');
    await app.close();

    app = await boot();
    expect(app.store.state.sessions[sessionId]).toMatchObject({
      origin: 'board',
      projectId,
      model: 'opus',
      permissionMode: 'acceptEdits',
      status: { kind: 'interrupted', turnRunning: true },
    });
    expect(app.sessionRunner.isLive(sessionId)).toBe(false);
    // Nothing is re-sent on its own.
    expect(calls).toHaveLength(1);

    expect(await app.sessionRunner.resumeSession(sessionId)).toEqual({ ok: true, sessionId });
    expect(calls[1]?.options).toMatchObject({ resume: sessionId, model: 'opus' });
    expect(calls[1]?.options).not.toHaveProperty('forkSession');
    expect(app.store.state.sessions[sessionId]?.status.kind).toBe('idle');
    expect(await app.sessionRunner.send(sessionId, 'Go on')).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls[1]?.prompts).toEqual(['Go on']);

    // A session closed on purpose doesn't come back.
    await app.sessionRunner.close(sessionId);
    await app.close();
    app = await boot();
    expect(app.store.state.sessions[sessionId]).toBeUndefined();
  });

  it('returns 404 for unknown routes', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { host, 'x-cboard-token': token },
    });
    expect(res.statusCode).toBe(404);
  });

  it('listens on loopback and serves health over HTTP', async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'cboard-app-'));
    app = await startServer({ ...config, port: 0, home: tmpHome }, { processes: false });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    expect(address.address).toBe('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: pkg.version });
  });
});

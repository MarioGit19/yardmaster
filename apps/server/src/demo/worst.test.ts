import type { AddressInfo } from 'node:net';
import { BoardState, type ServerToUi, SessionHistoryResponse } from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from '../app.js';
import type { ServerConfig } from '../config.js';
import { createSessionValue } from '../security.js';
import { generateToken } from '../token.js';
import { UI_WS_PATH } from '../ui-gateway.js';
import { WorstBoard } from './worst.js';

const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  home: '/home/dev/.yardmaster',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const T0 = 1_800_000_000_000;

let app: FastifyInstance | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
  vi.useRealTimers();
});

const byProject = <T extends { projectId: string | null }>(items: Record<string, T>) => {
  const counts = new Map<string | null, number>();
  for (const item of Object.values(items)) {
    counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
  }
  return counts;
};

describe('WorstBoard', () => {
  it('builds a valid board that covers the worst cases', () => {
    const board = new WorstBoard({ now: () => T0 });
    const state = BoardState.parse(board.store.state);
    const projects = Object.values(state.projects);
    const sessions = byProject(state.sessions);
    const terminals = byProject(state.terminals);

    expect(projects.some((p) => p.name.length > 50)).toBe(true);
    expect(projects.some((p) => p.git === null)).toBe(true);
    expect(projects.some((p) => /\p{Extended_Pictographic}/u.test(p.name))).toBe(true);
    expect(projects.some((p) => /[぀-ヿ一-鿿]/.test(p.name))).toBe(true);
    const counts = projects.map((p) => [sessions.get(p.id) ?? 0, terminals.get(p.id) ?? 0]);
    expect(counts).toContainEqual([0, 0]);
    expect(counts.some(([s, t]) => (s ?? 0) >= 100 && (t ?? 0) >= 100)).toBe(true);
    expect(Math.max(...counts.map(([s]) => s ?? 0).filter((s) => s < 100))).toBeGreaterThanOrEqual(
      6,
    );

    const tokens = Object.values(state.sessions).map(
      (s) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation,
    );
    expect(Math.max(...tokens)).toBeGreaterThan(1e10);
    expect(Object.values(state.sessions).some((s) => s.title === null && s.model === null)).toBe(
      true,
    );
    expect(Object.values(state.terminals).some((t) => t.name === '')).toBe(true);
    // A project with nothing but failures.
    expect(
      projects.some((p) => {
        const own = Object.values(state.sessions).filter((s) => s.projectId === p.id);
        return own.length > 0 && own.every((s) => s.status.kind === 'error');
      }),
    ).toBe(true);
    expect(Object.values(state.approvals).every((a) => a.state === 'pending')).toBe(true);
  });

  it('only writes output while someone watches', () => {
    vi.useFakeTimers();
    const board = new WorstBoard({ now: () => T0 });
    const bytes = () =>
      Object.values(board.store.state.executions).reduce((sum, e) => sum + e.outputBytes, 0);
    let watching = false;
    board.start(() => watching);
    const before = bytes();
    vi.advanceTimersByTime(3_000);
    expect(bytes()).toBe(before);
    watching = true;
    vi.advanceTimersByTime(3_000);
    expect(bytes()).toBeGreaterThan(before);
    board.stop();
  });
});

async function snapshot(port: number, query = ''): Promise<BoardState> {
  const origin = `http://127.0.0.1:${port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}${query}`, {
    headers: { origin, cookie: `yardmaster_session=${createSessionValue(token)}` },
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerToUi;
      if (message.type === 'snapshot') resolve(message.payload.state);
    });
  });
}

const names = (state: BoardState) => Object.values(state.projects).map((p) => p.name);

describe('/ws/ui?worst=1', () => {
  it('serves the worst-case board to demo clients that ask for it', async () => {
    app = await startServer(config, { token, demo: { seed: 1 } });
    const { port } = app.server.address() as AddressInfo;
    const regular = await snapshot(port);
    const worst = await snapshot(port, '?worst=1');
    expect(names(regular)).toContain('acme-shop');
    expect(names(worst)).not.toContain('acme-shop');
    expect(names(worst)).toContain('fleet-load-test');
    expect(names(await snapshot(port, '?worst=0'))).toContain('acme-shop');

    const id = Object.values(worst.projects).find((p) => p.name === 'fleet-load-test')?.id;
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/sessions`,
      headers: { host: `127.0.0.1:${port}`, 'x-yardmaster-token': token },
    });
    expect(res.statusCode).toBe(200);
    expect(SessionHistoryResponse.parse(res.json()).sessions.length).toBeGreaterThan(0);
  });

  it('is ignored outside demo mode', async () => {
    app = await startServer(config, { token, dbPath: ':memory:', processes: false, git: false });
    const { port } = app.server.address() as AddressInfo;
    expect(names(await snapshot(port, '?worst=1'))).toEqual([]);
  });
});

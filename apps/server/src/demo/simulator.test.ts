import {
  type ActivityEvent,
  type ActivityKind,
  applyPatch,
  BoardState,
  emptyBoardState,
  type PatchOp,
  type ServerToUi,
  type SessionStatusKind,
} from '@c-board/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../app.js';
import type { ServerConfig } from '../config.js';
import { BoardStore } from '../store.js';
import { generateToken } from '../token.js';
import { DEMO_PROJECTS } from './content.js';
import { DemoSimulator } from './simulator.js';

const T0 = 1_760_000_000_000;

function run(options: { seed?: number; permissionIntervalMs?: number } = {}) {
  const store = new BoardStore({ autoFlush: false });
  const activity: ActivityEvent[] = [];
  const messages: ServerToUi[] = [];
  const sim = new DemoSimulator({
    store,
    ...options,
    onActivity: (event) => activity.push(event),
    onMessage: (message) => messages.push(message),
  });
  const statuses = new Set<SessionStatusKind>();
  const observe = () => {
    for (const session of Object.values(store.state.sessions)) statuses.add(session.status.kind);
  };
  /** Advances virtual time, sampling session statuses every 100 ms. */
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      vi.advanceTimersByTime(100);
      observe();
    }
  };
  return { store, sim, activity, messages, statuses, advance };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DemoSimulator', () => {
  it('fills every entity type within 30 virtual seconds', () => {
    const { store, sim, advance } = run();
    sim.start();
    advance(30_000);

    const state = store.state;
    expect(BoardState.safeParse(state).success).toBe(true);
    expect(Object.keys(state.projects)).toHaveLength(5);
    expect(Object.values(state.projects).map((p) => p.name)).toEqual(
      DEMO_PROJECTS.map((p) => p.name),
    );
    for (const collection of Object.keys(state) as (keyof BoardState)[]) {
      expect(Object.keys(state[collection]).length, collection).toBeGreaterThan(0);
    }

    for (const project of Object.values(state.projects)) {
      expect(project.path.startsWith('/home/dev/')).toBe(true);
      const terminals = Object.values(state.terminals).filter((t) => t.projectId === project.id);
      expect(terminals.length).toBeGreaterThanOrEqual(2);
      expect(terminals.length).toBeLessThanOrEqual(5);
    }
    expect(Object.values(state.ports).map((p) => p.port)).toEqual(
      expect.arrayContaining([3000, 3001, 5173, 5174]),
    );
    expect(Object.values(state.approvals).some((a) => a.state === 'pending')).toBe(true);
    sim.stop();
  });

  it('streams ANSI-colored output into the execution and terminal buffers', () => {
    const { store, sim, advance } = run();
    sim.start();
    advance(10_000);

    const server = Object.values(store.state.executions).find((e) => e.commandLine === 'pnpm dev');
    expect(server).toBeDefined();
    const read = store.output.read(`exec:${server?.id}`, 0);
    const text = read?.chunks.map((c) => c.chunk).join('') ?? '';
    expect(text).toContain('Next.js');
    expect(text).toContain('\x1b[');
    expect(store.output.read(`term:${server?.terminalId}`, 0)?.chunks.length).toBeGreaterThan(0);
    sim.stop();
  });

  it('cycles sessions through realistic states, tools, crashes and subagents', () => {
    const { store, sim, activity, messages, statuses, advance } = run();
    sim.start();
    advance(10 * 60_000);

    expect([...statuses]).toEqual(
      expect.arrayContaining(['unknown', 'idle', 'working', 'tool', 'waiting_permission']),
    );
    const kinds = new Set<ActivityKind>(activity.map((e) => e.kind));
    for (const kind of [
      'session.start',
      'prompt',
      'tool.start',
      'tool.end',
      'stop',
      'permission.request',
      'permission.decision',
      'subagent.start',
      'subagent.stop',
      'exec.start',
      'exec.end',
    ] as const) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    // Dev servers crash now and then; tests fail sometimes.
    expect(activity.some((e) => e.kind === 'exec.end' && e.data.exitCode !== 0)).toBe(true);
    expect(messages.some((m) => m.type === 'approval.new')).toBe(true);
    // Undecided approvals expire.
    expect(
      messages.some((m) => m.type === 'approval.resolved' && m.payload.state === 'expired'),
    ).toBe(true);

    const sessions = Object.values(store.state.sessions);
    expect(sessions.some((s) => s.tokens.output > 0 && s.lastAssistantText)).toBe(true);
    expect(sessions.some((s) => s.todos.length > 0)).toBe(true);
    expect(BoardState.safeParse(store.state).success).toBe(true);
    sim.stop();
  });

  it('requests permission about every 45 seconds', () => {
    const { sim, activity, advance } = run();
    sim.start();
    advance(5 * 60_000);
    const requests = activity.filter((e) => e.kind === 'permission.request').length;
    // 300 s / 45 s ≈ 6.7, with jitter and the wait for a working session.
    expect(requests).toBeGreaterThanOrEqual(5);
    expect(requests).toBeLessThanOrEqual(9);
    sim.stop();
  });

  it('waits for a decision and resumes the session once allowed', () => {
    const { store, sim, messages, advance } = run();
    sim.start();
    advance(30_000);

    const approval = Object.values(store.state.approvals).find((a) => a.state === 'pending');
    if (!approval) throw new Error('expected a pending approval');
    expect(store.state.sessions[approval.sessionId]?.status).toEqual({
      kind: 'waiting_permission',
      approvalId: approval.id,
    });
    // Still waiting a little later: nothing decides on the user's behalf.
    advance(5_000);
    expect(store.state.sessions[approval.sessionId]?.status.kind).toBe('waiting_permission');

    expect(sim.decideApproval({ approvalId: approval.id, decision: 'allow' })).toEqual({
      ok: true,
    });
    expect(store.state.approvals[approval.id]?.state).toBe('allowed');
    expect(store.state.sessions[approval.sessionId]?.status).toMatchObject({
      kind: 'tool',
      tool: approval.tool,
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'approval.resolved',
        payload: { approvalId: approval.id, state: 'allowed', reason: null },
      }),
    );
    // A second decision for the same approval is refused.
    expect(sim.decideApproval({ approvalId: approval.id, decision: 'deny' })).toEqual({
      ok: false,
      error: 'unknown_approval',
    });
    sim.stop();
  });

  it('records a denial with its reason', () => {
    const { store, sim, advance } = run();
    sim.start();
    advance(30_000);
    const approval = Object.values(store.state.approvals).find((a) => a.state === 'pending');
    if (!approval) throw new Error('expected a pending approval');
    sim.decideApproval({ approvalId: approval.id, decision: 'deny', reason: 'not now' });
    expect(store.state.approvals[approval.id]).toMatchObject({
      state: 'denied',
      reason: 'not now',
    });
    expect(store.state.sessions[approval.sessionId]?.status.kind).toBe('working');
    expect(sim.decideApproval({ approvalId: 'nope', decision: 'allow' }).ok).toBe(false);
    sim.stop();
  });

  it('emits through store patches that rebuild the same state', () => {
    const { store, sim } = run();
    const ops: PatchOp[] = [];
    store.onPatch((batch) => ops.push(...batch));
    sim.start();
    for (let t = 0; t < 20_000; t += 50) {
      vi.advanceTimersByTime(50);
      store.flush();
    }
    expect(applyPatch(emptyBoardState(), ops)).toEqual(store.state);
    sim.stop();
  });

  it('keeps every emitted state valid over 30 virtual seconds', () => {
    for (const seed of [0xc0ffee, 1, 2, 3, 7, 42]) {
      vi.setSystemTime(T0);
      const { store, sim } = run({ seed });
      sim.start();
      for (let t = 0; t < 30_000; t += 100) {
        vi.advanceTimersByTime(100);
        const result = BoardState.safeParse(store.state);
        expect(result.success, `seed ${seed} at ${t} ms: ${result.error?.message}`).toBe(true);
      }
      for (const terminal of Object.values(store.state.terminals)) {
        if (terminal.stats) expect(terminal.stats.rssBytes).toBeGreaterThan(0);
      }
      sim.stop();
    }
  });

  it('is reproducible for a seed and stops cleanly', () => {
    const a = run({ seed: 7 });
    a.sim.start();
    a.advance(15_000);
    a.sim.stop();
    expect(vi.getTimerCount()).toBe(0);
    const snapshot = structuredClone(a.store.state);
    vi.advanceTimersByTime(60_000);
    expect(a.store.state).toEqual(snapshot);

    vi.setSystemTime(T0);
    const b = run({ seed: 7 });
    b.sim.start();
    b.advance(15_000);
    b.sim.stop();
    expect(b.store.state).toEqual(snapshot);
  });
});

describe('demo server', () => {
  const config: ServerConfig = {
    port: 4317,
    host: '127.0.0.1',
    home: '/home/dev/.c-board',
    logLevel: 'silent',
    devOrigins: [],
  };

  it('runs the simulator, routes approvals to it, and stops on close', async () => {
    const app = await buildServer(config, { token: generateToken(), demo: { seed: 3 } });
    try {
      expect(app.demo?.isRunning).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(Object.keys(app.store.state.projects)).toHaveLength(5);
      expect(app.persistence.listActivity().length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
    expect(app.demo?.isRunning).toBe(false);
  });

  it('is off by default', async () => {
    const app = await buildServer(config, {
      token: generateToken(),
      dbPath: ':memory:',
      processes: false,
    });
    expect(app.demo).toBeNull();
    await app.close();
  });
});

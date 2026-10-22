import {
  ActivityEvent,
  type ActivityKind,
  applyPatch,
  BoardState,
  decodeChatMessage,
  emptyBoardState,
  type PatchOp,
  parseToolCall,
  type ServerToUi,
  type SessionStatusKind,
  transcriptStreamId,
} from '@c-board/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../app.js';
import type { ServerConfig } from '../config.js';
import { BoardStore } from '../store.js';
import { generateToken } from '../token.js';
import { DEMO_PROJECTS } from './content.js';
import { DEMO_LONG_HISTORY, DemoSimulator } from './simulator.js';

const T0 = 1_760_000_000_000;

function run(options: { seed?: number; permissionIntervalMs?: number } = {}) {
  const store = new BoardStore({ autoFlush: false });
  const activity: ActivityEvent[] = [];
  /** The Pulse backfill, kept apart so assertions about live behavior only see live events. */
  const past: ActivityEvent[] = [];
  const messages: ServerToUi[] = [];
  const sim = new DemoSimulator({
    store,
    ...options,
    onActivity: (event) => (event.id.startsWith('demo-past-') ? past : activity).push(event),
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
  return { store, sim, activity, past, messages, statuses, advance };
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
    expect(Object.keys(state.projects)).toHaveLength(DEMO_PROJECTS.length);
    expect(Object.values(state.projects).map((p) => p.name)).toEqual(
      DEMO_PROJECTS.map((p) => p.name),
    );
    for (const collection of Object.keys(state) as (keyof BoardState)[]) {
      expect(Object.keys(state[collection]).length, collection).toBeGreaterThan(0);
    }

    for (const project of Object.values(state.projects)) {
      expect(project.path.startsWith('/home/dev/')).toBe(true);
      const terminals = Object.values(state.terminals).filter((t) => t.projectId === project.id);
      expect(terminals.length).toBeGreaterThanOrEqual(1);
      expect(terminals.length).toBeLessThanOrEqual(5);
    }
    // One project of each kind for the board's activity states (DESIGN.md §4.10): a dev server
    // that crashed and stays down, and a quiet project with nothing recent.
    const storybook = Object.values(state.terminals).find((t) => t.name === 'storybook');
    const newest = state.executions[storybook?.executionIds.at(-1) ?? ''];
    expect(newest?.exitCode).toBe(1);
    const quiet = Object.values(state.projects).find((p) => p.name === 'field-notes');
    expect(Date.now() - (quiet?.lastActivityAt ?? Date.now())).toBeGreaterThan(5 * 60_000);
    expect(
      Object.values(state.executions).some(
        (e) => state.terminals[e.terminalId]?.projectId === quiet?.id,
      ),
    ).toBe(false);
    expect(Object.values(state.ports).map((p) => p.port)).toEqual(
      expect.arrayContaining([3000, 3001, 5173, 5174]),
    );
    expect(Object.values(state.approvals).some((a) => a.state === 'pending')).toBe(true);
    sim.stop();
  });

  it('publishes transcripts: a long history, then the live turns', () => {
    const { store, sim, advance } = run();
    const live: string[] = [];
    sim.transcripts.onData((streamId) => live.push(streamId));
    sim.start();
    advance(3 * 60_000);

    const read = (id: string) =>
      (sim.transcripts.read(transcriptStreamId(id), 0)?.chunks ?? []).map((c) =>
        decodeChatMessage(c.chunk),
      );
    const sessions = Object.values(store.state.sessions);
    expect(sessions.length).toBeGreaterThan(0);
    const lengths = sessions.map((s) => read(s.id).length);
    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(DEMO_LONG_HISTORY);

    const messages = sessions.flatMap((s) => read(s.id));
    expect(messages.every((m) => m !== null)).toBe(true);
    const kinds = new Set(messages.map((m) => m?.kind));
    expect([...kinds]).toEqual(
      expect.arrayContaining(['user', 'assistant', 'thinking', 'tool_use', 'tool_result']),
    );
    expect(messages.some((m) => m?.kind === 'assistant' && m.text.includes('```'))).toBe(true);
    // Every tool card variant has something to show (7.9).
    const tools = new Set(messages.flatMap((m) => (m?.kind === 'tool_use' ? [m.name] : [])));
    expect([...tools]).toEqual(
      expect.arrayContaining([
        'Bash',
        'Edit',
        'MultiEdit',
        'Write',
        'Read',
        'Grep',
        'Glob',
        'TodoWrite',
        'Task',
        'WebFetch',
        'WebSearch',
        'mcp__tracker__create_ticket',
      ]),
    );
    // Built-in tools parse into their cards; only the MCP tool takes the generic view.
    for (const m of messages) {
      if (m?.kind !== 'tool_use') continue;
      expect(parseToolCall(m.name, m.input).kind === 'other').toBe(m.name.startsWith('mcp__'));
    }
    // Every tool result answers a tool call earlier in the same transcript.
    for (const s of sessions) {
      const seen = new Set<string>();
      for (const m of read(s.id)) {
        if (m?.kind === 'tool_use') seen.add(m.toolUseId);
        if (m?.kind === 'tool_result') expect(seen.has(m.toolUseId)).toBe(true);
      }
    }
    expect(live.length).toBeGreaterThan(DEMO_LONG_HISTORY);
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

  describe('terminal actions', () => {
    const execsOf = (store: BoardStore, terminalId: string) =>
      (store.state.terminals[terminalId]?.executionIds ?? []).map(
        (id) => store.state.executions[id],
      );
    const outputOf = (store: BoardStore, execId: string | undefined) =>
      store.output
        .read(`exec:${execId}`, 0)
        ?.chunks.map((c) => c.chunk)
        .join('') ?? '';

    it('runs a typed command and echoes its output', async () => {
      const { store, sim, advance } = run();
      sim.start();
      advance(500);
      const actions = sim.terminalActions();
      const shell = 'demo-term-acme-shop-3';

      const result = await actions['terminal.sendText']({
        kind: 'terminal.sendText',
        terminalId: shell,
        text: 'echo "hello from the board"',
        execute: true,
      });
      expect(result).toEqual({ ok: true });
      advance(500);
      const typed = execsOf(store, shell).find((e) => e?.commandLine.startsWith('echo'));
      expect(typed?.exitCode).toBe(0);
      expect(outputOf(store, typed?.id)).toBe('hello from the board\r\n');

      await actions['terminal.sendText']({
        kind: 'terminal.sendText',
        terminalId: shell,
        text: 'false',
        execute: true,
      });
      advance(500);
      expect(execsOf(store, shell).at(-1)).toMatchObject({ commandLine: 'false', exitCode: 1 });
      sim.stop();
    });

    it('stops a dev server on Ctrl+C and reruns it', async () => {
      const { store, sim, advance } = run();
      sim.start();
      advance(5_000);
      const actions = sim.terminalActions();
      const dev = 'demo-term-acme-shop-1';
      const server = execsOf(store, dev).at(-1);
      expect(server?.endedAt).toBeNull();

      await actions['terminal.interrupt']({ kind: 'terminal.interrupt', terminalId: dev });
      expect(store.state.executions[server?.id ?? '']?.exitCode).toBe(130);
      expect(outputOf(store, server?.id)).toContain('^C');
      expect(Object.values(store.state.ports).some((p) => p.terminalId === dev)).toBe(false);

      await actions['terminal.rerun']({ kind: 'terminal.rerun', execId: server?.id ?? '' });
      advance(3_000);
      const rerun = execsOf(store, dev).at(-1);
      expect(rerun?.id).not.toBe(server?.id);
      expect(rerun).toMatchObject({ commandLine: server?.commandLine, endedAt: null });
      sim.stop();
    });

    it('rejects unknown terminals and leaves creation to a real editor', async () => {
      const { sim } = run();
      sim.start();
      const actions = sim.terminalActions();
      expect(
        await actions['terminal.sendText']({
          kind: 'terminal.sendText',
          terminalId: 'nope',
          text: 'ls',
          execute: true,
        }),
      ).toEqual({ ok: false, error: 'unknown_terminal' });
      expect(
        await actions['terminal.create']({ kind: 'terminal.create', projectId: 'a1b2c3d4e5f6' }),
      ).toEqual({ ok: false, error: 'editor_offline' });
      sim.stop();
    });
  });

  it('backfills the last 15 minutes of activity for the Pulse rail', () => {
    const { store, sim, past, advance } = run();
    sim.start();
    advance(3_000);
    expect(past.length).toBeGreaterThan(40);
    for (const event of past) {
      expect(ActivityEvent.safeParse(event).success).toBe(true);
      expect(event.ts).toBeGreaterThan(T0 - 15 * 60_000);
      expect(event.ts).toBeLessThan(Date.now());
      expect(store.state.terminals[event.terminalId ?? '']).toBeDefined();
    }
    const kinds = new Set(past.map((e) => e.kind));
    for (const kind of ['prompt', 'tool.start', 'stop', 'exec.start', 'exec.end'] as const) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    // Every project has a lane, and session events point at real sessions.
    expect(new Set(past.map((e) => e.projectId)).size).toBe(DEMO_PROJECTS.length);
    for (const event of past.filter((e) => e.sessionId !== null)) {
      expect(store.state.sessions[event.sessionId ?? '']).toBeDefined();
    }
    sim.stop();
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
      expect(Object.keys(app.store.state.projects)).toHaveLength(DEMO_PROJECTS.length);
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

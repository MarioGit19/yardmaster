import {
  type Approval,
  applyPatch,
  BoardState,
  type EditorWindow,
  type PatchOp,
  type PortBinding,
  type Project,
} from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { execStreamId, terminalStreamId } from './output-buffers.js';
import { BoardStore, type BoardStoreOptions, commandHeader } from './store.js';

const ESC = '\x1b';
const T0 = 1_760_000_000_000;

const project: Project = {
  id: 'p-acme',
  path: '/home/dev/acme-shop',
  name: 'acme-shop',
  accent: 3,
  source: 'editor',
  git: null,
  createdAt: T0,
  lastActivityAt: null,
};

const window: EditorWindow = {
  id: 'w-1',
  appName: 'Cursor',
  appVersion: '1.0.0',
  extensionVersion: '0.1.0',
  workspaceFolders: ['/home/dev/acme-shop'],
  projectIds: ['p-acme'],
  capabilities: { shellExecution: true },
  connectedAt: T0,
  lastSeenAt: T0,
};

function makeStore(options: BoardStoreOptions = {}) {
  let clock = T0;
  const store = new BoardStore({ autoFlush: false, now: () => clock, ...options });
  return { store, tick: (ms = 1) => (clock += ms) };
}

function seeded(options: BoardStoreOptions = {}) {
  const ctx = makeStore(options);
  ctx.store.upsertProject(project);
  ctx.store.upsertWindow(window);
  ctx.store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', projectId: 'p-acme' });
  ctx.store.flush();
  return ctx;
}

describe('BoardStore mutators', () => {
  it('upserts projects and windows', () => {
    const { store, tick } = makeStore();
    store.upsertProject(project);
    store.upsertWindow(window);
    expect(store.state.projects['p-acme']).toEqual(project);
    tick(500);
    store.touchWindow('w-1');
    expect(store.state.windows['w-1']?.lastSeenAt).toBe(T0 + 500);
    store.touchProject('p-acme');
    expect(store.state.projects['p-acme']?.lastActivityAt).toBe(T0 + 500);
    store.touchProject('p-acme', T0);
    expect(store.state.projects['p-acme']?.lastActivityAt).toBe(T0 + 500);
    store.removeProject('p-acme');
    expect(store.state.projects).toEqual({});
  });

  it('creates terminals with defaults and merges later upserts', () => {
    const { store } = seeded();
    const created = store.state.terminals['t-1'];
    expect(created).toMatchObject({
      state: 'open',
      shellPid: null,
      executionIds: [],
      createdAt: T0,
      projectId: 'p-acme',
    });
    store.upsertTerminal({
      id: 't-1',
      windowId: 'w-1',
      name: 'pnpm dev',
      shellPid: 4242,
      cwd: undefined,
    });
    expect(store.state.terminals['t-1']).toMatchObject({
      name: 'pnpm dev',
      shellPid: 4242,
      projectId: 'p-acme',
    });
    store.closeTerminal('t-1', 130);
    expect(store.state.terminals['t-1']).toMatchObject({
      state: 'closed',
      exitCode: 130,
      closedAt: T0,
    });
    store.setTerminalStats('t-1', {
      pid: 4242,
      cpu: 12.5,
      rssBytes: 1024,
      processCount: 3,
      sampledAt: T0,
    });
    expect(store.state.terminals['t-1']?.stats?.cpu).toBe(12.5);
    expect(BoardState.safeParse(store.state).success).toBe(true);
  });

  it('records executions, output and exit', () => {
    const { store, tick } = seeded();
    tick(10);
    const exec = store.startExec({
      execId: 'e-1',
      terminalId: 't-1',
      commandLine: 'pnpm test',
      confidence: 'high',
      cwd: '/home/dev/acme-shop',
    });
    expect(exec?.startedAt).toBe(T0 + 10);
    expect(store.state.terminals['t-1']?.executionIds).toEqual(['e-1']);
    expect(store.state.projects['p-acme']?.lastActivityAt).toBe(T0 + 10);
    expect(
      store.startExec({
        execId: 'e-1',
        terminalId: 't-1',
        commandLine: 'again',
        confidence: 'low',
        cwd: null,
      }),
    ).toBe(exec);
    expect(
      store.startExec({
        execId: 'e-x',
        terminalId: 'nope',
        commandLine: 'ls',
        confidence: 'low',
        cwd: null,
      }),
    ).toBeUndefined();

    expect(store.appendExecOutput('e-1', `${ESC}]633;C${ESC}\\${ESC}[32mPASS${ESC}[0m\n`, 0)).toBe(
      true,
    );
    expect(store.appendExecOutput('e-1', 'ignored replay', 0)).toBe(false);
    expect(store.appendExecOutput('missing', 'x')).toBe(false);
    store.appendExecOutput('e-1', 'é', 1);
    expect(store.state.executions['e-1']?.outputBytes).toBe(`${ESC}[32mPASS${ESC}[0m\n`.length + 2);

    store.endExec('e-1', 0, T0 + 99);
    expect(store.state.executions['e-1']).toMatchObject({
      exitCode: 0,
      endedAt: T0 + 99,
      truncated: false,
      interactive: false,
    });
    store.endExec('e-1', 1, T0 + 200);
    expect(store.state.executions['e-1']?.exitCode).toBe(0);

    const text = (id: string) =>
      store.output
        .read(id as never)
        ?.chunks.map((c) => c.chunk)
        .join('');
    expect(text(execStreamId('e-1'))).toBe(`${ESC}[32mPASS${ESC}[0m\né`);
    expect(text(terminalStreamId('t-1'))).toBe(
      `${commandHeader('pnpm test')}\r\n${ESC}[32mPASS${ESC}[0m\né`,
    );
    expect(BoardState.safeParse(store.state).success).toBe(true);
  });

  it('flushes a marker split at the end of an execution', () => {
    const { store } = seeded();
    store.startExec({
      execId: 'e-1',
      terminalId: 't-1',
      commandLine: 'x',
      confidence: 'low',
      cwd: null,
    });
    store.appendExecOutput('e-1', `done${ESC}]6`);
    expect(store.state.executions['e-1']?.outputBytes).toBe(4);
    store.endExec('e-1', 0);
    expect(store.state.executions['e-1']?.outputBytes).toBe(7);
  });

  it('marks an execution truncated once its buffer drops output', () => {
    const { store } = seeded({ buffers: { execBytes: 16, terminalBytes: 64 } });
    store.startExec({
      execId: 'e-1',
      terminalId: 't-1',
      commandLine: 'yes',
      confidence: 'high',
      cwd: null,
    });
    for (let i = 0; i < 10; i++) store.appendExecOutput('e-1', 'y\ny\ny\n', i);
    const exec = store.state.executions['e-1'];
    expect(exec).toMatchObject({ outputBytes: 60, truncated: true });
    const replay = store.output.read(execStreamId('e-1'), 0);
    expect(replay?.truncated).toBe(true);
    expect(replay?.nextSeq).toBe(10);
  });

  it('caps executions per terminal and drops their output', () => {
    const { store } = seeded({ maxExecutionsPerTerminal: 2 });
    for (const id of ['e-1', 'e-2', 'e-3']) {
      store.startExec({
        execId: id,
        terminalId: 't-1',
        commandLine: id,
        confidence: 'high',
        cwd: null,
      });
      store.appendExecOutput(id, id);
    }
    expect(store.state.terminals['t-1']?.executionIds).toEqual(['e-2', 'e-3']);
    expect(Object.keys(store.state.executions)).toEqual(['e-2', 'e-3']);
    expect(store.output.has(execStreamId('e-1'))).toBe(false);
  });

  it('removes a window with its terminals, executions and buffers', () => {
    const { store } = seeded();
    store.startExec({
      execId: 'e-1',
      terminalId: 't-1',
      commandLine: 'ls',
      confidence: 'high',
      cwd: null,
    });
    store.appendExecOutput('e-1', 'out');
    store.removeWindow('w-1');
    expect(store.state.windows).toEqual({});
    expect(store.state.terminals).toEqual({});
    expect(store.state.executions).toEqual({});
    expect(store.output.has(terminalStreamId('t-1'))).toBe(false);
    expect(store.output.has(execStreamId('e-1'))).toBe(false);
  });

  it('stamps assistant text with the time it was set', () => {
    const { store, tick } = seeded();
    store.upsertSession({ id: 's-1' });
    tick(5);
    store.updateSession('s-1', { lastAssistantText: 'Done.' });
    expect(store.state.sessions['s-1']?.lastAssistantAt).toBe(T0 + 5);
    store.updateSession('s-1', { lastAssistantText: 'Old.', lastAssistantAt: T0 });
    expect(store.state.sessions['s-1']?.lastAssistantAt).toBe(T0);
    store.updateSession('s-1', { lastAssistantText: null });
    expect(store.state.sessions['s-1']).toMatchObject({
      lastAssistantText: null,
      lastAssistantAt: null,
    });
  });

  it('creates sessions with defaults and tracks status', () => {
    const { store, tick } = seeded();
    const session = store.upsertSession({
      id: 's-1',
      projectId: 'p-acme',
      cwd: '/home/dev/acme-shop',
    });
    expect(session).toMatchObject({
      origin: 'terminal',
      status: { kind: 'unknown', alive: true },
      startedAt: T0,
    });
    tick(5);
    store.updateSession('s-1', {
      currentTool: {
        id: 'tu-1',
        sessionId: 's-1',
        tool: 'Bash',
        family: 'bash',
        summary: 'pnpm test',
        startedAt: T0,
        endedAt: null,
        status: 'running',
      },
    });
    store.setSessionStatus('s-1', { kind: 'tool', tool: 'Bash', toolUseId: 'tu-1' });
    expect(store.state.sessions['s-1']?.currentTool?.id).toBe('tu-1');
    store.setSessionStatus('s-1', {
      kind: 'compacting',
      previous: { kind: 'working' },
    });
    expect(store.state.sessions['s-1']?.currentTool).toBeNull();
    tick(5);
    store.setSessionStatus('s-1', { kind: 'ended' });
    expect(store.state.sessions['s-1']).toMatchObject({
      status: { kind: 'ended' },
      endedAt: T0 + 10,
      updatedAt: T0 + 10,
    });
    expect(store.state.projects['p-acme']?.lastActivityAt).toBe(T0 + 10);
    store.upsertSession({ id: 's-1', title: 'Fix cart totals', model: undefined });
    expect(store.state.sessions['s-1']).toMatchObject({
      title: 'Fix cart totals',
      projectId: 'p-acme',
    });
    expect(BoardState.safeParse(store.state).success).toBe(true);
  });

  it('resolves approvals once and removes them with their session', () => {
    const { store } = seeded();
    store.upsertSession({ id: 's-1' });
    const approval: Approval = {
      id: 'a-1',
      sessionId: 's-1',
      source: 'hook',
      tool: 'Bash',
      input: { command: 'rm -rf dist' },
      toolUseId: 'tu-9',
      createdAt: T0,
      expiresAt: null,
      state: 'pending',
      decidedAt: null,
      reason: null,
    };
    store.upsertApproval(approval);
    store.resolveApproval('a-1', 'allowed', null, T0 + 3);
    store.resolveApproval('a-1', 'denied', 'too late', T0 + 4);
    expect(store.state.approvals['a-1']).toMatchObject({
      state: 'allowed',
      decidedAt: T0 + 3,
      reason: null,
    });
    store.removeSession('s-1');
    expect(store.state.approvals).toEqual({});
    expect(store.state.sessions).toEqual({});
  });

  it('replaces ports from a scan and keeps first sightings', () => {
    const { store } = makeStore();
    const vite: PortBinding = {
      id: '127.0.0.1:5173',
      port: 5173,
      address: '127.0.0.1',
      pid: 101,
      command: 'node',
      terminalId: null,
      projectId: null,
      firstSeenAt: T0,
    };
    const rails = { ...vite, id: '127.0.0.1:3000', port: 3000, pid: 202, command: 'ruby' };
    store.setPorts([vite, rails]);
    store.flush();
    store.setPorts([{ ...vite, firstSeenAt: T0 + 9_000 }]);
    expect(store.state.ports).toEqual({ [vite.id]: vite });
    expect(store.flush()).toEqual([{ op: 'delete', path: ['ports', rails.id] }]);
  });
});

describe('BoardStore patch emission', () => {
  it('emits coalesced ops that rebuild the new state from the old', () => {
    const { store } = makeStore();
    const batches: PatchOp[][] = [];
    store.onPatch((ops) => batches.push(ops));
    let mirror = store.state;

    const steps: Array<() => void> = [
      () => {
        store.upsertProject(project);
        store.upsertWindow(window);
        store.upsertTerminal({ id: 't-1', windowId: 'w-1', name: 'zsh', projectId: 'p-acme' });
      },
      () => {
        store.startExec({
          execId: 'e-1',
          terminalId: 't-1',
          commandLine: 'pnpm dev',
          confidence: 'high',
          cwd: null,
        });
        store.appendExecOutput('e-1', 'VITE ready\n');
        store.upsertSession({ id: 's-1', projectId: 'p-acme' });
      },
      () => {
        store.setSessionStatus('s-1', { kind: 'working' });
        store.endExec('e-1', 1);
        store.closeTerminal('t-1', 1);
      },
      () => store.removeWindow('w-1'),
    ];
    for (const step of steps) {
      step();
      const ops = store.flush();
      mirror = applyPatch(mirror, ops);
      expect(mirror).toEqual(store.state);
    }
    expect(batches).toHaveLength(steps.length);
    expect(store.flush()).toEqual([]);
    expect(batches).toHaveLength(steps.length);
  });

  it('coalesces repeated changes to one field into a single op', () => {
    const { store } = seeded();
    store.startExec({
      execId: 'e-1',
      terminalId: 't-1',
      commandLine: 'ls',
      confidence: 'high',
      cwd: null,
    });
    store.flush();
    for (let i = 0; i < 50; i++) store.appendExecOutput('e-1', 'x');
    expect(store.flush()).toEqual([
      { op: 'set', path: ['executions', 'e-1', 'outputBytes'], value: 50 },
    ]);
  });

  it('auto-flushes once per microtask', async () => {
    const store = new BoardStore({ now: () => T0 });
    const batches: PatchOp[][] = [];
    const off = store.onPatch((ops) => batches.push(ops));
    store.upsertProject(project);
    store.touchProject('p-acme', T0 + 1);
    expect(batches).toHaveLength(0);
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(applyPatch({ ...store.state, projects: {} }, batches[0] ?? [])).toEqual(store.state);
    off();
    store.removeProject('p-acme');
    await Promise.resolve();
    expect(batches).toHaveLength(1);
  });
});

describe('commandHeader', () => {
  it('shows the command after a dim prompt, flattening control characters', () => {
    expect(commandHeader('pnpm test')).toBe(`${ESC}[2m$${ESC}[22m ${ESC}[1mpnpm test${ESC}[22m`);
    expect(commandHeader(`echo a\nb${ESC}[31m`)).toBe(
      `${ESC}[2m$${ESC}[22m ${ESC}[1mecho a b [31m${ESC}[22m`,
    );
    expect(commandHeader('  \n ')).toBeNull();
    expect(commandHeader('x'.repeat(3_000))).toContain(`${'x'.repeat(2_000)}…`);
  });
});

describe('OutputBuffers live data', () => {
  it('streams stripped chunks with per-stream seqs', () => {
    const { store } = seeded();
    const seen: Array<[string, number, string]> = [];
    store.output.onData((id, seq, chunk) => seen.push([id, seq, chunk]));
    store.startExec({
      execId: 'e-1',
      terminalId: 't-1',
      commandLine: 'a',
      confidence: 'high',
      cwd: null,
    });
    store.appendExecOutput('e-1', `${ESC}]633;C${ESC}\\one`);
    store.startExec({
      execId: 'e-2',
      terminalId: 't-1',
      commandLine: 'b',
      confidence: 'high',
      cwd: null,
    });
    store.appendExecOutput('e-2', 'two');
    expect(seen).toEqual([
      ['term:t-1', 0, `${commandHeader('a')}\r\n`],
      ['exec:e-1', 0, 'one'],
      ['term:t-1', 1, 'one'],
      // 'one' left the cursor mid-line, so the next header starts a line of its own.
      ['term:t-1', 2, `\r\n${commandHeader('b')}\r\n`],
      ['exec:e-2', 0, 'two'],
      ['term:t-1', 3, 'two'],
    ]);
  });
});

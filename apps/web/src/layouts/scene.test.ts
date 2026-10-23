import type { Approval, BoardState, Execution, PortBinding } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { SLEEP_AFTER_MS } from '../crew/model.js';
import type { Pulses } from '../data/activity.js';
import { makeProject, makeSession, makeTerminal, sampleBoard } from '../test/board.js';
import { actorId, buildSceneModel, buildSceneProject, opsStateFor } from './scene.js';

const T0 = 1_760_000_000_000;
const NOW = T0 + 60_000;

function exec(id: string, terminalId: string, over: Partial<Execution> = {}): Execution {
  return {
    id,
    terminalId,
    commandLine: 'pnpm test',
    confidence: 'high',
    cwd: null,
    startedAt: T0,
    endedAt: null,
    exitCode: null,
    outputBytes: 0,
    truncated: false,
    interactive: false,
    ...over,
  };
}

function port(terminalId: string, n = 5173): PortBinding {
  return {
    id: `127.0.0.1:${n}`,
    port: n,
    address: '127.0.0.1',
    pid: 4242,
    command: 'node',
    terminalId,
    projectId: 'p-acme',
    firstSeenAt: T0,
  };
}

function addTerminal(board: BoardState, id: string, projectId: string, executions: Execution[]) {
  const terminal = makeTerminal(id, projectId);
  terminal.executionIds = executions.map((e) => e.id);
  board.terminals[id] = terminal;
  for (const e of executions) board.executions[e.id] = e;
  return terminal;
}

const open = makeTerminal('t-x', 'p-acme');

describe('opsStateFor', () => {
  it('is running while a command runs, serving when it also listens', () => {
    expect(opsStateFor(open, [exec('e1', 't-x')], { now: NOW })).toBe('running');
    expect(opsStateFor(open, [exec('e1', 't-x')], { now: NOW, listening: true })).toBe('serving');
  });

  it('reads the newest execution, whatever the order', () => {
    const old = exec('e1', 't-x', { startedAt: T0, endedAt: T0 + 5, exitCode: 1 });
    const fresh = exec('e2', 't-x', { startedAt: T0 + 10 });
    expect(opsStateFor(open, [old, fresh], { now: NOW })).toBe('running');
    expect(opsStateFor(open, [fresh, old], { now: NOW })).toBe('running');
  });

  it('shows a crash as error, but not Ctrl+C', () => {
    const crashed = exec('e1', 't-x', { endedAt: T0 + 5, exitCode: 2 });
    const stopped = exec('e1', 't-x', { endedAt: T0 + 5, exitCode: 130 });
    expect(opsStateFor(open, [crashed], { now: NOW })).toBe('error');
    expect(opsStateFor(open, [stopped], { now: NOW })).toBe('idle');
  });

  it('plays done briefly after a clean exit, then rests', () => {
    const ok = exec('e1', 't-x', { endedAt: NOW - 200, exitCode: 0 });
    expect(opsStateFor(open, [ok], { now: NOW })).toBe('done');
    expect(opsStateFor(open, [ok], { now: NOW + 5_000 })).toBe('idle');
  });

  it('falls asleep after five quiet minutes, and output keeps it awake', () => {
    const later = T0 + SLEEP_AFTER_MS + 1;
    expect(opsStateFor(open, [], { now: later })).toBe('sleeping');
    expect(opsStateFor(open, [], { now: later, lastOutputAt: later - 1_000 })).toBe('idle');
  });

  it('is exited once the terminal closes', () => {
    expect(opsStateFor({ ...open, state: 'closed' }, [exec('e1', 't-x')], { now: NOW })).toBe(
      'exited',
    );
  });
});

describe('buildSceneModel', () => {
  it('orders projects attention first: waiting, then errors, then by name', () => {
    const board = sampleBoard();
    board.projects['p-alpha'] = makeProject('p-alpha', 'alpha-site');
    const scene = buildSceneModel(board, {}, NOW);
    expect(scene.projects.map((p) => p.id)).toEqual(['p-acme', 'p-zen', 'p-alpha', 'p-orbit']);
    expect(scene.projects.map((p) => p.tone)).toEqual(['wait', 'err', 'idle', 'work']);
  });

  it('turns sessions into Claude actors with state, caption, name and links', () => {
    const board = sampleBoard();
    const approval: Approval = {
      id: 'ap-1',
      sessionId: 's-1',
      source: 'hook',
      tool: 'Bash',
      input: { command: 'pnpm test' },
      toolUseId: 'tu-1',
      state: 'pending',
      createdAt: T0,
      expiresAt: null,
      decidedAt: null,
      reason: null,
    } as Approval;
    board.approvals[approval.id] = approval;
    const session = board.sessions['s-1'];
    if (!session) throw new Error('fixture');
    session.status = { kind: 'waiting_permission', approvalId: 'ap-1' };
    session.currentTool = {
      toolUseId: 'tu-1',
      tool: 'Bash',
      family: 'bash',
      summary: 'pnpm test',
      startedAt: T0,
      status: 'running',
    } as never;
    const scene = buildSceneModel(board, {}, NOW);
    const actor = scene.actors.get(actorId.session('s-1'));
    expect(actor).toMatchObject({
      kind: 'claude',
      projectId: 'p-acme',
      state: 'waiting',
      tone: 'wait',
      // Unnamed sessions are "Claude" (the title is Claude Code's summary, not a name).
      label: 'Claude',
      links: { href: '/p/p-acme/s/s-1', sessionId: 's-1', approvalId: 'ap-1', terminalId: null },
    });
    expect(actor?.caption.text).toBe('Waiting for approval: Bash(pnpm test)');
    expect(actor?.name).toBe('acme-shop, Claude, waiting for approval: Bash(pnpm test)');
  });

  it('takes activity levels from the pulses', () => {
    const pulses: Pulses = {
      's:s-2': { energy: 3, at: NOW, lastAt: NOW, events: 4, doneAt: null },
    };
    const scene = buildSceneModel(sampleBoard(), pulses, NOW);
    expect(scene.actors.get('s:s-2')?.activity).toBeCloseTo(1 - Math.exp(-3));
    expect(scene.actors.get('s:s-1')?.activity).toBe(0);
  });

  it('lists open terminals with their ops state and a terminal link, skipping closed ones', () => {
    const board = sampleBoard();
    addTerminal(board, 't-dev', 'p-acme', [exec('e1', 't-dev', { commandLine: 'pnpm dev' })]);
    board.ports['127.0.0.1:5173'] = port('t-dev');
    const scene = buildSceneModel(board, {}, NOW);
    const dev = scene.actors.get(actorId.terminal('t-dev'));
    expect(dev).toMatchObject({
      kind: 'terminal',
      state: 'serving',
      tone: 'ok',
      links: { href: '/p/p-acme/t/t-dev', terminalId: 't-dev', sessionId: null },
    });
    expect(dev?.caption.text).toBe('Serving: pnpm dev');
    // The sample's crashed terminal is closed: not on stage.
    expect(scene.actors.has(actorId.terminal('t-1'))).toBe(false);
  });

  it('draws a terminal running Claude Code as its session, linked to the terminal', () => {
    const board = sampleBoard();
    addTerminal(board, 't-claude', 'p-orbit', [
      exec('e1', 't-claude', { commandLine: 'claude', interactive: true }),
    ]);
    const session = board.sessions['s-2'];
    if (!session) throw new Error('fixture');
    session.terminalId = 't-claude';
    const project = buildSceneProject(board, {}, 'p-orbit', NOW);
    expect(project?.actors.map((a) => a.id)).toEqual(['s:s-2']);
    expect(project?.actors[0]?.links.terminalId).toBe('t-claude');
  });

  it('adds running subagents and background tasks right after their session', () => {
    const board = sampleBoard();
    addTerminal(board, 't-a', 'p-orbit', []);
    const session = board.sessions['s-2'];
    if (!session) throw new Error('fixture');
    session.subagents = [
      {
        id: 'ag-1',
        type: 'Explore',
        description: 'Find the limiter',
        status: 'running',
        startedAt: T0 + 1,
        endedAt: null,
      },
      {
        id: 'ag-2',
        type: 'Plan',
        description: 'Done already',
        status: 'done',
        startedAt: T0,
        endedAt: T0 + 2,
      },
    ] as never;
    session.background = [
      {
        id: 'bg-1',
        kind: 'shell',
        label: 'Typecheck watcher',
        status: 'running',
        startedAt: T0 + 2,
        endedAt: null,
        exitCode: null,
        tail: 'Found 0 errors.\nWatching for file changes.',
      },
    ] as never;
    const project = buildSceneProject(board, {}, 'p-orbit', NOW);
    const actors = project?.actors ?? [];
    expect(actors.map((a) => [a.id, a.kind, a.parentId])).toEqual([
      ['s:s-2', 'claude', null],
      ['b:s-2:ag-1', 'subagent', 's:s-2'],
      ['b:s-2:bg-1', 'background', 's:s-2'],
      ['t:t-a', 'terminal', null],
    ]);
    expect(actors[1]).toMatchObject({ label: 'Explore: Find the limiter', state: 'thinking' });
    expect(actors[2]).toMatchObject({ state: 'running', links: { href: '/p/p-orbit/s/s-2' } });
    expect(actors[2]?.caption.text).toBe('Watching for file changes.');
  });

  it('orders actors inside a project attention first', () => {
    const board = sampleBoard();
    addTerminal(board, 't-crash', 'p-acme', [
      exec('e1', 't-crash', { endedAt: T0 + 5, exitCode: 1 }),
    ]);
    addTerminal(board, 't-idle', 'p-acme', []);
    board.sessions['s-3'] = makeSession('s-3', 'p-acme', { kind: 'idle' });
    board.sessions['s-4'] = makeSession('s-4', 'p-acme', {
      kind: 'tool',
      tool: 'Read',
      toolUseId: null,
    });
    const project = buildSceneProject(board, {}, 'p-acme', NOW);
    expect(project?.actors.map((a) => a.id)).toEqual([
      's:s-1', // waiting
      't:t-crash', // error
      's:s-4', // reading
      's:s-3', // idle, Claude before terminals
      't:t-idle',
    ]);
  });

  it('returns null for a project that is gone', () => {
    expect(buildSceneProject(sampleBoard(), {}, 'p-gone', NOW)).toBeNull();
  });
});

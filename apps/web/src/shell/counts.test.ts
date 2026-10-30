import type { Execution } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { createBoardStore } from '../data/store.js';
import { makeSession, makeTerminal, sampleBoard } from '../test/board.js';
import { hudSeverity, selectHudCounts, selectHudItems, startOfLocalDay } from './counts.js';

const NOW = new Date(2026, 3, 14, 15, 30).getTime();

function execution(id: string, terminalId: string, over: Partial<Execution> = {}): Execution {
  return {
    id,
    terminalId,
    commandLine: 'pnpm dev',
    confidence: 'high',
    cwd: null,
    startedAt: NOW - 60_000,
    endedAt: null,
    exitCode: null,
    outputBytes: 0,
    truncated: false,
    interactive: false,
    ...over,
  };
}

function stateOf(edit: (board: ReturnType<typeof sampleBoard>) => void = () => {}) {
  const board = sampleBoard();
  edit(board);
  const store = createBoardStore();
  store.getState().replaceBoard(board);
  return store.getState();
}

const countsOf = (edit?: (board: ReturnType<typeof sampleBoard>) => void) =>
  selectHudCounts(() => NOW)(stateOf(edit));

describe('startOfLocalDay', () => {
  it('is local midnight of the same day', () => {
    expect(startOfLocalDay(NOW)).toBe(new Date(2026, 3, 14).getTime());
  });
});

describe('selectHudCounts', () => {
  it('counts the sample board: one busy, one waiting, one crashed terminal', () => {
    expect(countsOf()).toEqual({ needsYou: 1, failed: 1, active: 1, tokensToday: 0 });
  });

  it('counts tool and compacting sessions as active, waiting input as needing you', () => {
    const counts = countsOf((board) => {
      for (const [id, status] of [
        ['a', { kind: 'tool', tool: 'Bash', toolUseId: null }],
        ['b', { kind: 'compacting', previous: { kind: 'idle' } }],
        ['c', { kind: 'waiting_input' }],
        ['d', { kind: 'error', message: null }],
        ['e', { kind: 'ended' }],
        ['f', { kind: 'idle' }],
      ] as const) {
        board.sessions[id] = makeSession(id, 'p-acme', status);
      }
    });
    expect(counts).toMatchObject({ active: 3, needsYou: 2, failed: 2 });
  });

  it('counts an idle session with background work running as active, once', () => {
    const shell = {
      id: 'b1',
      kind: 'shell' as const,
      label: 'Watcher',
      startedAt: NOW,
      endedAt: null,
      status: 'running' as const,
      exitCode: null,
      pid: null,
    };
    const counts = countsOf((board) => {
      board.sessions.bg = { ...makeSession('bg', 'p-acme', { kind: 'idle' }), background: [shell] };
      board.sessions.busy = {
        ...makeSession('busy', 'p-acme', { kind: 'working' }),
        background: [shell],
      };
      board.sessions.gone = {
        ...makeSession('gone', 'p-acme', { kind: 'ended' }),
        background: [shell],
      };
      board.sessions.done = {
        ...makeSession('done', 'p-acme', { kind: 'idle' }),
        background: [{ ...shell, status: 'done', endedAt: NOW }],
      };
    });
    expect(counts.active).toBe(3);
  });

  it('counts running commands and failed last commands like the lanes do', () => {
    const counts = countsOf((board) => {
      const running = makeTerminal('t-run', 'p-acme');
      running.executionIds = ['e-old', 'e-run'];
      board.executions['e-old'] = execution('e-old', 't-run', { endedAt: NOW, exitCode: 1 });
      board.executions['e-run'] = execution('e-run', 't-run');
      const failed = makeTerminal('t-fail', 'p-orbit');
      failed.executionIds = ['e-fail'];
      board.executions['e-fail'] = execution('e-fail', 't-fail', { endedAt: NOW, exitCode: 2 });
      const ok = makeTerminal('t-ok', 'p-orbit');
      ok.executionIds = ['e-ok'];
      board.executions['e-ok'] = execution('e-ok', 't-ok', { endedAt: NOW, exitCode: 0 });
      for (const t of [running, failed, ok]) board.terminals[t.id] = t;
    });
    expect(counts).toMatchObject({ active: 2, failed: 2 });
  });

  it('counts claude running in a terminal once', () => {
    const counts = countsOf((board) => {
      const terminal = makeTerminal('t-claude', 'p-acme');
      terminal.executionIds = ['e-claude'];
      board.executions['e-claude'] = execution('e-claude', 't-claude');
      board.terminals[terminal.id] = terminal;
      board.sessions['s-t'] = {
        ...makeSession('s-t', 'p-acme', { kind: 'idle' }),
        terminalId: 't-claude',
        origin: 'terminal',
      };
    });
    expect(counts.active).toBe(1);
  });

  it('drops a failed terminal once seen, until it fails again', () => {
    const fail = (id: string) => (board: ReturnType<typeof sampleBoard>) => {
      const failed = makeTerminal('t-fail', 'p-orbit');
      failed.executionIds = [id];
      board.executions[id] = execution(id, 't-fail', { endedAt: NOW, exitCode: 2 });
      board.terminals[failed.id] = failed;
    };
    const seen = new Set(['e-1']);
    const counted = (id: string) => selectHudCounts(() => NOW, seen)(stateOf(fail(id))).failed;
    expect(countsOf(fail('e-1')).failed).toBe(2);
    expect(counted('e-1')).toBe(1);
    expect(counted('e-2')).toBe(2);
  });

  it('lists the items behind a count', () => {
    const state = stateOf();
    const failed = selectHudItems('failed')(state);
    expect(failed.map((i) => i.kind)).toEqual(['terminal']);
    const active = selectHudItems('active')(state);
    expect(active.map((i) => (i.kind === 'session' ? i.session.id : i.terminal.id))).toEqual([
      's-2',
    ]);
  });

  it('colours the group by its most severe non-zero counter', () => {
    expect(hudSeverity({ needsYou: 1, failed: 1, active: 1 })).toBe('wait');
    expect(hudSeverity({ needsYou: 0, failed: 1, active: 1 })).toBe('err');
    expect(hudSeverity({ needsYou: 0, failed: 0, active: 1 })).toBe('work');
    expect(hudSeverity({ needsYou: 0, failed: 0, active: 0 })).toBeNull();
  });

  it('sums tokens of sessions active since local midnight', () => {
    const counts = countsOf((board) => {
      const today = makeSession('today', 'p-acme', { kind: 'idle' });
      today.updatedAt = startOfLocalDay(NOW) + 1;
      today.tokens = { input: 100, output: 50, cacheRead: 1000, cacheCreation: 10 };
      const yesterday = makeSession('yesterday', 'p-acme', { kind: 'idle' });
      yesterday.updatedAt = startOfLocalDay(NOW) - 1;
      board.sessions[today.id] = today;
      board.sessions[yesterday.id] = yesterday;
    });
    expect(counts.tokensToday).toBe(1160);
  });
});

import type { Execution } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { createBoardStore } from '../data/store.js';
import { makeSession, makeTerminal, sampleBoard } from '../test/board.js';
import { selectHudCounts, startOfLocalDay } from './counts.js';

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

function countsOf(edit: (board: ReturnType<typeof sampleBoard>) => void = () => {}) {
  const board = sampleBoard();
  edit(board);
  const store = createBoardStore();
  store.getState().replaceBoard(board);
  return selectHudCounts(() => NOW)(store.getState());
}

describe('startOfLocalDay', () => {
  it('is local midnight of the same day', () => {
    expect(startOfLocalDay(NOW)).toBe(new Date(2026, 3, 14).getTime());
  });
});

describe('selectHudCounts', () => {
  it('counts the sample board: one working, one waiting, one crashed terminal', () => {
    expect(countsOf()).toEqual({ working: 1, waiting: 1, running: 0, errors: 1, tokensToday: 0 });
  });

  it('counts tool and compacting sessions as working, waiting input as waiting', () => {
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
    expect(counts).toMatchObject({ working: 3, waiting: 2, errors: 2 });
  });

  it('counts an idle session with background work running as working, once', () => {
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
    expect(counts.working).toBe(3);
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
    expect(counts).toMatchObject({ running: 1, errors: 2 });
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

import type { BoardState, Execution } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { makeTerminal, sampleBoard } from '../test/board.js';
import { arrivedTerminal, recentCommands, terminalHost } from './newTerminal.js';

const T0 = 1_760_000_000_000;

function run(id: string, terminalId: string, commandLine: string, at: number, interactive = false) {
  return {
    id,
    terminalId,
    commandLine,
    confidence: 'high',
    cwd: null,
    startedAt: T0 + at,
    endedAt: null,
    exitCode: null,
    outputBytes: 0,
    truncated: false,
    interactive,
  } satisfies Execution;
}

function board(): BoardState {
  const b = sampleBoard();
  b.terminals['t-a'] = makeTerminal('t-a', 'p-acme');
  b.terminals['t-b'] = makeTerminal('t-b', 'p-acme', 0);
  b.terminals['t-x'] = makeTerminal('t-x', 'p-orbit');
  const runs = [
    run('e1', 't-a', 'pnpm dev', 1),
    run('e2', 't-a', 'pnpm  test', 2),
    run('e3', 't-b', 'git status', 3),
    run('e4', 't-a', 'pnpm dev', 4),
    run('e5', 't-a', 'claude', 5, true),
    run('e6', 't-a', 'claude --resume abc', 6),
    run('e7', 't-a', 'htop', 7, true),
    run('e8', 't-a', '   ', 8),
    run('e9', 't-x', 'cargo run', 9),
  ];
  for (const r of runs) b.executions[r.id] = r;
  return b;
}

describe('recentCommands', () => {
  it("lists the project's distinct commands, newest first, without claude or TUIs", () => {
    expect(recentCommands(board(), 'p-acme')).toEqual(['pnpm dev', 'git status', 'pnpm test']);
    expect(recentCommands(board(), 'p-orbit')).toEqual(['cargo run']);
    expect(recentCommands(board(), 'p-zen')).toEqual([]);
  });

  it('keeps at most `max`', () => {
    const b = board();
    for (let i = 0; i < 8; i++) {
      const r = run(`n${i}`, 't-a', `echo ${i}`, 100 + i);
      b.executions[r.id] = r;
    }
    expect(recentCommands(b, 'p-acme')).toEqual(['echo 7', 'echo 6', 'echo 5', 'echo 4', 'echo 3']);
    expect(recentCommands(b, 'p-acme', 2)).toEqual(['echo 7', 'echo 6']);
  });
});

describe('arrivedTerminal', () => {
  it('finds the newest open terminal that was not there before', () => {
    const known = new Set(['t-1']);
    const t1 = { id: 't-1', state: 'open' as const, createdAt: 1 };
    const closed = { id: 't-2', state: 'closed' as const, createdAt: 5 };
    expect(arrivedTerminal(known, [t1, closed])).toBeNull();
    const t3 = { id: 't-3', state: 'open' as const, createdAt: 3 };
    const t4 = { id: 't-4', state: 'open' as const, createdAt: 4 };
    expect(arrivedTerminal(known, [t1, t3, t4, closed])).toBe('t-4');
  });
});

describe('terminalHost', () => {
  const status = (available: boolean) => ({
    boardTerminals: { available, reason: available ? null : 'no binary', live: 0, max: 16 },
  });

  it('prefers the editor window, else a board terminal', () => {
    expect(terminalHost(true, status(false))).toBe('editor');
    expect(terminalHost(false, status(true))).toBe('board');
  });

  it('has nowhere to open one when board terminals are off', () => {
    expect(terminalHost(false, status(false))).toBe('none');
  });

  it('lets the server answer while the status is unknown', () => {
    expect(terminalHost(false, null)).toBe('board');
    expect(terminalHost(false, 'error')).toBe('board');
    expect(terminalHost(false, {})).toBe('board');
  });
});

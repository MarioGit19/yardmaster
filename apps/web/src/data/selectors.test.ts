import { describe, expect, it } from 'vitest';
import { makeSession, makeTerminal, sampleBoard } from '../test/board.js';
import { selectTerminalSession } from './selectors.js';
import type { BoardStoreState } from './store.js';

function state() {
  const board = sampleBoard();
  board.terminals['t-claude'] = makeTerminal('t-claude', 'p-acme');
  board.terminals['t-shell'] = makeTerminal('t-shell', 'p-acme');
  const linked = makeSession('s-linked', 'p-acme', { kind: 'idle' }, 'Checkout fix');
  board.sessions[linked.id] = { ...linked, terminalId: 't-claude' };
  return { board } as BoardStoreState;
}

describe('selectTerminalSession', () => {
  it("finds the terminal's live linked session, keeping its identity", () => {
    const s = state();
    expect(selectTerminalSession('t-claude')(s)).toBe(s.board.sessions['s-linked']);
    expect(selectTerminalSession('t-shell')(s)).toBeUndefined();
    expect(selectTerminalSession('nope')(s)).toBeUndefined();
  });

  it('ignores ended sessions, board sessions and closed terminals', () => {
    const ended = state();
    const session = ended.board.sessions['s-linked'];
    if (!session) throw new Error('missing session');
    ended.board.sessions['s-linked'] = { ...session, status: { kind: 'ended' } };
    expect(selectTerminalSession('t-claude')(ended)).toBeUndefined();

    const board = state();
    const fromBoard = board.board.sessions['s-linked'];
    if (!fromBoard) throw new Error('missing session');
    board.board.sessions['s-linked'] = { ...fromBoard, origin: 'board' };
    expect(selectTerminalSession('t-claude')(board)).toBeUndefined();

    const closed = state();
    closed.board.terminals['t-claude'] = makeTerminal('t-claude', 'p-acme', 0);
    expect(selectTerminalSession('t-claude')(closed)).toBeUndefined();
  });

  it('picks the newest session when a terminal ran claude twice', () => {
    const s = state();
    const older = s.board.sessions['s-linked'];
    if (!older) throw new Error('missing session');
    s.board.sessions['s-newer'] = {
      ...older,
      id: 's-newer',
      startedAt: older.startedAt + 1_000,
    };
    expect(selectTerminalSession('t-claude')(s)?.id).toBe('s-newer');
  });
});

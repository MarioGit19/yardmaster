import { describe, expect, it } from 'vitest';
import { laneExecution, laneView } from './lanes/lane.js';
import { buildSceneModel } from './layouts/scene.js';
import {
  NOTHING_NEW,
  projectStatusTone,
  type StatusContext,
  seenKey,
  sessionToken,
  sessionView,
  terminalToken,
} from './statusTokens.js';
import { makeSession, makeTerminal, sampleBoard } from './test/board.js';

const NOW = 1_000_000_000;

function context(over: Partial<StatusContext> = {}): StatusContext {
  return { board: sampleBoard(), pulses: {}, live: true, seen: NOTHING_NEW, now: NOW, ...over };
}

const working = () => ({
  ...makeSession('s', 'p', { kind: 'working' }),
  updatedAt: NOW - 1_000,
});

describe('session tokens', () => {
  it('stays Running while events arrive and goes Stale when they stop', () => {
    expect(sessionToken(working(), context())).toBe('running');
    expect(sessionToken({ ...working(), updatedAt: NOW - 11 * 60_000 }, context())).toBe('stale');
  });

  it('takes output as an event too', () => {
    const silent = { ...working(), updatedAt: 0 };
    const pulses = { 's:s': { level: 0, lastAt: NOW - 1_000, at: NOW - 1_000 } };
    expect(sessionToken(silent, context({ pulses: pulses as never }))).toBe('running');
  });

  it('calls every Running stale once the connection drops', () => {
    expect(sessionView(working(), context({ live: false }))).toEqual({
      tone: 'stale',
      label: 'Stale',
    });
  });

  it('shows a finished turn as unseen until this browser opens it', () => {
    const done = { ...makeSession('s', 'p', { kind: 'idle' as const }), lastAssistantAt: NOW - 10 };
    const fresh = { since: NOW - 100, marks: {} };
    expect(sessionToken(done, context({ seen: fresh }))).toBe('done_unseen');
    expect(sessionToken(done, context({ seen: { since: NOW, marks: {} } }))).toBe('quiet');
    const opened = { ...fresh, marks: { [seenKey.session('s')]: NOW - 10 } };
    expect(sessionToken(done, context({ seen: opened }))).toBe('quiet');
  });
});

describe('terminal tokens', () => {
  const lane = { running: true, exit: null };
  const execution = { startedAt: NOW - 1_000, endedAt: null };

  it('goes Stale when its editor window is gone, not for a board terminal', () => {
    const editor = { ...makeTerminal('t', 'p'), windowId: 'gone' };
    expect(terminalToken(editor, execution, lane, context())).toBe('stale');
    const board = { ...editor, origin: 'board' as const };
    expect(terminalToken(board, execution, lane, context())).toBe('running');
  });

  it('marks only a long command as Done, unseen', () => {
    const terminal = makeTerminal('t', 'p');
    const ended = { running: false, exit: { key: 'e', code: 0 } };
    const seen = { since: 0, marks: {} };
    const token = (ms: number) =>
      terminalToken(terminal, { startedAt: NOW - ms, endedAt: NOW }, ended, context({ seen }));
    expect(token(1_000)).toBe('quiet');
    expect(token(60_000)).toBe('done_unseen');
  });
});

describe('the scene', () => {
  it('uses the same tokens, and stops a frozen actor from acting', () => {
    const board = sampleBoard();
    const session = {
      ...makeSession('s-stale', 'p-acme', { kind: 'tool', tool: 'Edit', toolUseId: null }),
      updatedAt: NOW - 1_000,
    };
    board.sessions[session.id] = session;
    const actor = buildSceneModel(board, {}, NOW, { live: false }).actors.get('s:s-stale');
    expect(actor).toMatchObject({ state: 'stale', token: 'stale', tone: 'stale' });
    expect(actor?.caption.text).toBe('Connection lost');
  });

  it('ranks stale under Running and over a quiet project', () => {
    const ctx = context({ live: false });
    expect(projectStatusTone([working()], [], ctx)).toBe('stale');
    expect(projectStatusTone([], [], ctx)).toBe('idle');
  });

  it('agrees with the lane on what a terminal shows', () => {
    const terminal = { ...makeTerminal('t', 'p', 2), state: 'closed' as const };
    const execution = laneExecution(sampleBoard(), terminal);
    const lane = laneView(terminal, execution, '');
    expect(lane.tone).toBe('err');
    expect(terminalToken(terminal, execution, lane, context())).toBe('failed');
  });
});

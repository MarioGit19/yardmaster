import { type ActivityEvent, type Execution, HISTORY_WINDOW_MS } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { makeTerminal, sampleBoard } from '../test/board.js';
import {
  ACTIVITY_TAU_MS,
  activityKey,
  ingestEvents,
  levelAt,
  levelStep,
  QUIET_LEVEL,
} from './activity.js';
import { selectCrashedCount } from './selectors.js';
import { createBoardStore, MAX_ACTIVITY, mergeActivity } from './store.js';

// Synthetic sample data only.
const NOW = 1_760_000_000_000;

const event = (
  id: string,
  ts: number,
  kind: ActivityEvent['kind'] = 'prompt',
  sessionId: string | null = null,
): ActivityEvent => ({
  id,
  ts,
  kind,
  projectId: 'p-acme',
  sessionId,
  terminalId: null,
  execId: null,
  summary: null,
  data: {},
});

describe('mergeActivity', () => {
  it('appends in time order, dropping duplicates and events outside the window', () => {
    const current = [event('a', NOW - 3_000), event('b', NOW - 2_000)];
    const merged = mergeActivity(
      current,
      [event('b', NOW - 2_000), event('late', NOW - 2_500), event('c', NOW - 1_000)],
      NOW,
    );
    expect(merged.map((e) => e.id)).toEqual(['a', 'late', 'b', 'c']);

    const stale = mergeActivity(current, [event('old', NOW - HISTORY_WINDOW_MS - 120_000)], NOW);
    expect(stale).toBe(current);
    const later = mergeActivity(current, [], NOW + HISTORY_WINDOW_MS + 60_000 - 2_500);
    expect(later.map((e) => e.id)).toEqual(['b']);
  });

  it('caps the number of events', () => {
    const many = Array.from({ length: MAX_ACTIVITY + 10 }, (_, i) => event(`e${i}`, NOW - 1_000));
    const merged = mergeActivity([], many, NOW);
    expect(merged).toHaveLength(MAX_ACTIVITY);
    expect(merged.at(-1)?.id).toBe(`e${MAX_ACTIVITY + 9}`);
  });
});

describe('store activity', () => {
  it('replaces the window on a replay and appends live batches', () => {
    const store = createBoardStore();
    store.getState().addActivity([event('a', NOW - 5_000)], false, NOW);
    store.getState().addActivity([event('b', NOW - 4_000)], true, NOW);
    expect(store.getState().activity.map((e) => e.id)).toEqual(['b']);
    const before = store.getState().activity;
    store.getState().addActivity([event('b', NOW - 4_000)], false, NOW);
    expect(store.getState().activity).toBe(before);
    store.getState().addActivity([event('c', NOW)], false, NOW);
    expect(store.getState().activity.map((e) => e.id)).toEqual(['b', 'c']);
  });
});

const execution = (id: string, terminalId: string, outputBytes: number): Execution => ({
  id,
  terminalId,
  commandLine: 'pnpm dev',
  confidence: 'high',
  cwd: null,
  startedAt: NOW - 10_000,
  endedAt: null,
  exitCode: null,
  outputBytes,
  truncated: false,
  interactive: false,
});

describe('activity levels', () => {
  const P = activityKey.project('p-acme');
  const S = activityKey.session('s-1');

  it('rises with events and decays exponentially without them', () => {
    const pulses = ingestEvents({}, [event('a', NOW, 'tool.start', 's-1')], sampleBoard(), NOW);
    const level = levelAt(pulses[P], NOW);
    expect(level).toBeCloseTo(1 - Math.exp(-1));
    expect(levelAt(pulses[S], NOW)).toBeCloseTo(level);
    const later = levelAt(pulses[P], NOW + ACTIVITY_TAU_MS);
    expect(later).toBeCloseTo(1 - Math.exp(-Math.exp(-1)));
    expect(levelAt(pulses[P], NOW + 10 * ACTIVITY_TAU_MS)).toBeLessThan(QUIET_LEVEL);
    expect(levelAt(undefined, NOW)).toBe(0);
  });

  it('steps: quiet, then busier with more events', () => {
    expect(levelStep(0)).toBe(0);
    expect(levelStep(QUIET_LEVEL)).toBe(1);
    const burst = Array.from({ length: 4 }, (_, i) => event(`e${i}`, NOW - i * 100));
    const pulses = ingestEvents({}, burst, sampleBoard(), NOW);
    expect(levelStep(levelAt(pulses[P], NOW))).toBe(3);
    expect(pulses[P]?.events).toBe(4);
    expect(pulses[P]?.lastAt).toBe(NOW);
  });

  it('records when a turn finished, and keeps untouched pulses', () => {
    const first = ingestEvents({}, [event('a', NOW - 50, 'prompt', 's-1')], sampleBoard(), NOW);
    const next = ingestEvents(first, [event('b', NOW, 'stop', 's-1')], sampleBoard(), NOW);
    expect(next[S]?.doneAt).toBe(NOW);
    expect(first[S]?.doneAt).toBeNull();
    expect(ingestEvents(next, [], sampleBoard(), NOW)).toBe(next);
  });

  it('counts terminal output from patches, for the terminal and its project', () => {
    const store = createBoardStore();
    const board = sampleBoard();
    board.terminals['t-2'] = makeTerminal('t-2', 'p-acme');
    board.executions.x = execution('x', 't-2', 0);
    store.getState().replaceBoard(board);
    store
      .getState()
      .applyOps([{ op: 'set', path: ['executions', 'x', 'outputBytes'], value: 3_000 }], NOW);
    const { pulses } = store.getState();
    expect(levelAt(pulses[activityKey.terminal('t-2')], NOW)).toBeCloseTo(1 - Math.exp(-1));
    expect(levelAt(pulses[P], NOW)).toBeGreaterThan(0.5);
    expect(pulses[P]?.events).toBe(0);
    const before = store.getState().pulses;
    store.getState().applyOps([{ op: 'set', path: ['projects', 'p-acme', 'name'], value: 'x' }]);
    expect(store.getState().pulses).toBe(before);
  });

  it('does not count a replayed event twice', () => {
    const store = createBoardStore();
    store.getState().addActivity([event('a', NOW)], false, NOW);
    store.getState().addActivity([event('a', NOW)], true, NOW);
    expect(store.getState().pulses[P]?.events).toBe(1);
  });
});

describe('selectCrashedCount', () => {
  it('counts open terminals whose newest command failed, not Ctrl+C', () => {
    const store = createBoardStore();
    const board = sampleBoard();
    const ended = (id: string, terminalId: string, exitCode: number) => ({
      ...execution(id, terminalId, 10),
      endedAt: NOW,
      exitCode,
    });
    for (const [id, exits] of [
      ['t-a', [0, 1]],
      ['t-b', [1, 0]],
      ['t-c', [130]],
    ] as const) {
      const terminal = makeTerminal(id, 'p-acme');
      terminal.executionIds = exits.map((_, i) => `${id}-${i}`);
      board.terminals[id] = terminal;
      exits.forEach((code, i) => {
        board.executions[`${id}-${i}`] = ended(`${id}-${i}`, id, code);
      });
    }
    store.getState().replaceBoard(board);
    expect(selectCrashedCount('p-acme')(store.getState())).toBe(1);
    expect(selectCrashedCount('p-orbit')(store.getState())).toBe(0);
  });
});

import { type ActivityEvent, PULSE_WINDOW_MS } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { createBoardStore, MAX_ACTIVITY, mergeActivity } from './store.js';

// Synthetic sample data only.
const NOW = 1_760_000_000_000;

const event = (id: string, ts: number): ActivityEvent => ({
  id,
  ts,
  kind: 'prompt',
  projectId: 'p-acme',
  sessionId: null,
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

    const stale = mergeActivity(current, [event('old', NOW - PULSE_WINDOW_MS - 120_000)], NOW);
    expect(stale).toBe(current);
    const later = mergeActivity(current, [], NOW + PULSE_WINDOW_MS + 60_000 - 2_500);
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

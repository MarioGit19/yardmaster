import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeenItems } from './seen.js';

const transport = (marks = {}) => ({
  load: vi.fn(async () => ({ since: 5, marks })),
  save: vi.fn(async () => ({})),
});

describe('createSeenItems', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts only what happens after it started until the server answers', () => {
    const seen = createSeenItems(transport(), () => 100);
    expect(seen.get()).toEqual({ since: 100, marks: {} });
  });

  it('loads this browser’s record and keeps marks made in the meantime', async () => {
    const seen = createSeenItems(transport({ a: 1 }), () => 100);
    seen.mark('b');
    await seen.load();
    expect(seen.get()).toEqual({ since: 5, marks: { a: 1, b: 100 } });
  });

  it('applies a mark at once, tells subscribers and sends one batch', async () => {
    const remote = transport();
    const seen = createSeenItems(remote, () => 100);
    const listener = vi.fn();
    seen.subscribe(listener);
    seen.mark('a');
    seen.mark('a');
    seen.mark('b', 50);
    expect(listener).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(remote.save).toHaveBeenCalledTimes(1);
    expect(remote.save).toHaveBeenCalledWith({ a: 100, b: 50 });
  });

  it('survives a server that says no', async () => {
    const seen = createSeenItems(
      {
        load: async () => Promise.reject(new Error('no')),
        save: async () => Promise.reject(new Error('no')),
      },
      () => 100,
    );
    await seen.load();
    seen.mark('a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen.get().marks.a).toBe(100);
  });
});

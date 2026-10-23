import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDraftStore,
  DRAFT_PERSIST_MS,
  DRAFTS_KEY,
  type DraftStorage,
  draftKey,
  MAX_DRAFT_CHARS,
  MAX_DRAFTS,
} from './drafts.js';

function memoryStorage(): DraftStorage & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  return {
    data,
    writes: 0,
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) {
      this.writes += 1;
      data.set(key, value);
    },
    removeItem: (key) => void data.delete(key),
  };
}

const KEY = draftKey.session('5b1f0c2e-0000-4000-8000-000000000001');

describe('draft store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves a draft, debounced, and restores it in a new store (a reload)', () => {
    const storage = memoryStorage();
    const store = createDraftStore({ storage });
    store.set(KEY, 'Plan the');
    store.set(KEY, 'Plan the cart refactor');
    expect(store.get(KEY)).toBe('Plan the cart refactor');
    expect(storage.data.has(DRAFTS_KEY)).toBe(false);
    vi.advanceTimersByTime(DRAFT_PERSIST_MS);
    expect(storage.writes).toBe(1);
    expect(createDraftStore({ storage }).get(KEY)).toBe('Plan the cart refactor');
  });

  it('flushes pending text at once', () => {
    const storage = memoryStorage();
    const store = createDraftStore({ storage });
    store.set(KEY, 'half typed');
    store.flush();
    expect(createDraftStore({ storage }).get(KEY)).toBe('half typed');
  });

  it('clears a draft, and whitespace counts as none', () => {
    const storage = memoryStorage();
    const store = createDraftStore({ storage });
    store.set(KEY, 'hello');
    vi.runAllTimers();
    store.clear(KEY);
    expect(store.get(KEY)).toBe('');
    vi.runAllTimers();
    expect(storage.data.has(DRAFTS_KEY)).toBe(false);
    store.set(KEY, 'x');
    store.set(KEY, '  \n ');
    expect(store.getState().drafts[KEY]).toBeUndefined();
  });

  it('moves a draft to another input', () => {
    const store = createDraftStore({ storage: memoryStorage() });
    const fork = draftKey.session('5b1f0c2e-0000-4000-8000-000000000002');
    store.set(KEY, 'carry on');
    store.move(KEY, fork);
    expect(store.get(KEY)).toBe('');
    expect(store.get(fork)).toBe('carry on');
  });

  it('keeps the newest drafts and cuts long ones', () => {
    const storage = memoryStorage();
    let t = 0;
    const store = createDraftStore({ storage, now: () => ++t });
    for (let i = 0; i < MAX_DRAFTS + 5; i++) store.set(draftKey.newSession(`p${i}`), `text ${i}`);
    expect(Object.keys(store.getState().drafts)).toHaveLength(MAX_DRAFTS);
    expect(store.get(draftKey.newSession('p0'))).toBe('');
    expect(store.get(draftKey.newSession(`p${MAX_DRAFTS + 4}`))).toBe(`text ${MAX_DRAFTS + 4}`);

    store.set(KEY, 'a'.repeat(MAX_DRAFT_CHARS + 100));
    vi.runAllTimers();
    expect(createDraftStore({ storage }).get(KEY)).toHaveLength(MAX_DRAFT_CHARS);
  });

  it('works without storage, and with storage that throws or holds junk', () => {
    const none = createDraftStore({ storage: undefined });
    none.set(KEY, 'kept in memory');
    vi.runAllTimers();
    expect(none.get(KEY)).toBe('kept in memory');

    const broken: DraftStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    const store = createDraftStore({ storage: broken });
    store.set(KEY, 'still here');
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(store.get(KEY)).toBe('still here');

    const junk = memoryStorage();
    junk.data.set(DRAFTS_KEY, '{"a":{"text":1},"b":"x",');
    expect(createDraftStore({ storage: junk }).getState().drafts).toEqual({});
    junk.data.set(DRAFTS_KEY, JSON.stringify({ [KEY]: { text: 'ok', updatedAt: 1 }, bad: 3 }));
    expect(Object.keys(createDraftStore({ storage: junk }).getState().drafts)).toEqual([KEY]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createPreference, type KeyValueStorage } from './prefs.js';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const OPTIONS = ['a', 'b', 'c'] as const;

describe('createPreference', () => {
  it('reads a stored value and falls back on unknown or missing ones', () => {
    expect(createPreference('k', OPTIONS, 'a', memoryStorage({ k: 'b' })).get()).toBe('b');
    expect(createPreference('k', OPTIONS, 'a', memoryStorage({ k: 'zzz' })).get()).toBe('a');
    expect(createPreference('k', OPTIONS, 'a', memoryStorage()).get()).toBe('a');
    expect(createPreference('k', OPTIONS, 'a', undefined).get()).toBe('a');
  });

  it('persists, notifies and ignores invalid or unchanged values', () => {
    const storage = memoryStorage();
    const pref = createPreference('k', OPTIONS, 'a', storage);
    const listener = vi.fn();
    const unsubscribe = pref.subscribe(listener);

    pref.set('c');
    pref.set('c');
    pref.set('nope' as 'a');
    expect(pref.get()).toBe('c');
    expect(storage.getItem('k')).toBe('c');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    pref.set('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives storage that throws', () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const pref = createPreference('k', OPTIONS, 'b', broken);
    expect(pref.get()).toBe('b');
    pref.set('c');
    expect(pref.get()).toBe('c');
  });
});

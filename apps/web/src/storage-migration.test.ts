import { describe, expect, it } from 'vitest';
import { migrateStorage } from './storage-migration.js';

function memoryStore(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe('migrateStorage', () => {
  it('moves cboard.* keys to yardmaster.* and leaves other keys alone', () => {
    const localStorage = memoryStore({
      'cboard.layout': 'grid',
      'cboard.focus.p-zen': '{"left":280}',
      'cboard.push.id': 'synthetic-id',
      'other.key': 'kept',
    });
    migrateStorage({ localStorage });
    expect(Object.fromEntries(localStorage.map)).toEqual({
      'yardmaster.layout': 'grid',
      'yardmaster.focus.p-zen': '{"left":280}',
      'yardmaster.push.id': 'synthetic-id',
      'other.key': 'kept',
    });
  });

  it('keeps a value already saved under the new name', () => {
    const localStorage = memoryStore({ 'cboard.theme': 'light', 'yardmaster.theme': 'dark' });
    migrateStorage({ localStorage });
    expect(Object.fromEntries(localStorage.map)).toEqual({ 'yardmaster.theme': 'dark' });
  });

  it('moves session drafts and is a no-op the second time', () => {
    const sessionStorage = memoryStore({ 'c-board:drafts': '{}' });
    migrateStorage({ sessionStorage });
    migrateStorage({ sessionStorage });
    expect(Object.fromEntries(sessionStorage.map)).toEqual({ 'yardmaster:drafts': '{}' });
  });

  it('survives storage that throws', () => {
    const blocked = {
      get localStorage(): never {
        throw new Error('blocked');
      },
    };
    expect(() => migrateStorage(blocked)).not.toThrow();
  });

  it('runs from its own source text, as the build inlines it', () => {
    const localStorage = memoryStore({ 'cboard.motion': 'off' });
    new Function('scope', `(${migrateStorage.toString()})(scope)`)({ localStorage });
    expect(Object.fromEntries(localStorage.map)).toEqual({ 'yardmaster.motion': 'off' });
  });
});

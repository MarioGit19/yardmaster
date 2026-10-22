import { useSyncExternalStore } from 'react';

export interface Preference<T extends string> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * A small string-enum preference persisted in localStorage. Unknown stored values fall back to
 * the default, so a stale or hand-edited entry never breaks the UI.
 */
export function createPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
  storage: KeyValueStorage | undefined = defaultStorage(),
): Preference<T> {
  const listeners = new Set<() => void>();
  const read = (): T => {
    try {
      const raw = storage?.getItem(key);
      return raw !== null && raw !== undefined && (allowed as readonly string[]).includes(raw)
        ? (raw as T)
        : fallback;
    } catch {
      return fallback;
    }
  };
  let value = read();

  return {
    get: () => value,
    set(next) {
      if (!allowed.includes(next) || next === value) return;
      value = next;
      try {
        storage?.setItem(key, next);
      } catch {
        // Storage can be full or disabled; the in-memory value still applies.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function usePreference<T extends string>(pref: Preference<T>): T {
  return useSyncExternalStore(pref.subscribe, pref.get, pref.get);
}

/** Subscribes to a CSS media query; false where `matchMedia` is unavailable. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = globalThis.matchMedia?.(query);
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

import { useSyncExternalStore } from 'react';
import type { KeyValueStorage } from '../prefs.js';

const KEY = 'yardmaster.seenFailures';
/** Exit keys never expire on their own: the oldest drop off once there are this many. */
const MAX_SEEN = 300;

export interface SeenFailures {
  get(): ReadonlySet<string>;
  mark(key: string): void;
  subscribe(listener: () => void): () => void;
}

function parse(raw: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Which terminal failures this browser has looked at, by `LaneView.exit.key`. Kept per device, so
 * opening a failure on the phone leaves it on the Mac's Failed count.
 */
export function createSeenFailures(
  storage: KeyValueStorage | undefined = defaultStorage(),
): SeenFailures {
  const listeners = new Set<() => void>();
  let seen: ReadonlySet<string> = new Set(
    (() => {
      try {
        return parse(storage?.getItem(KEY));
      } catch {
        return [];
      }
    })(),
  );
  return {
    get: () => seen,
    mark(key) {
      if (seen.has(key)) return;
      seen = new Set([...seen, key].slice(-MAX_SEEN));
      try {
        storage?.setItem(KEY, JSON.stringify([...seen]));
      } catch {
        // Storage can be full or disabled; the in-memory set still applies.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const seenFailures = createSeenFailures();

export const useSeenFailures = () =>
  useSyncExternalStore(seenFailures.subscribe, seenFailures.get, seenFailures.get);

import type { SeenMarks, SeenResponse } from '@yardmaster/protocol';
import { useSyncExternalStore } from 'react';
import { api } from './settings/api.js';

/** Marks are sent in one batch, this long after the first of them. */
const FLUSH_MS = 1_000;
/** The list the board kept in this browser's storage before the server held it. */
const LEGACY_KEY = 'yardmaster.seenFailures';

export interface SeenTransport {
  load(): Promise<SeenResponse>;
  save(marks: SeenMarks): Promise<unknown>;
}

export interface SeenItems {
  get(): SeenResponse;
  /** Marks `key` as opened at `at`, here at once and on this browser's session soon after. */
  mark(key: string, at?: number): void;
  load(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

function takeLegacyMarks(now: number): SeenMarks {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(LEGACY_KEY) ?? '[]');
    globalThis.localStorage?.removeItem(LEGACY_KEY);
    if (!Array.isArray(value)) return {};
    const keys = value.filter((key): key is string => typeof key === 'string');
    return Object.fromEntries(keys.slice(-200).map((key) => [key, now]));
  } catch {
    return {};
  }
}

/**
 * Which finished sessions and terminal failures this browser has opened, held on its server-side
 * session. Per device: opening one on the phone leaves the Mac's mark in place.
 */
export function createSeenItems(
  transport: SeenTransport = { load: api.seen, save: (marks) => api.markSeen({ marks }) },
  now: () => number = Date.now,
): SeenItems {
  const listeners = new Set<() => void>();
  // Until the server answers, only what happens from now on is news.
  let state: SeenResponse = { since: now(), marks: {} };
  let pending: SeenMarks = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const flush = () => {
    timer = null;
    const marks = pending;
    pending = {};
    // A lost update only means a mark comes back on the next reload.
    transport.save(marks).catch(() => {});
  };
  const queue = (marks: SeenMarks) => {
    Object.assign(pending, marks);
    if (timer === null) timer = setTimeout(flush, FLUSH_MS);
  };
  return {
    get: () => state,
    mark(key, at = now()) {
      if ((state.marks[key] ?? -1) >= at) return;
      state = { ...state, marks: { ...state.marks, [key]: at } };
      queue({ [key]: at });
      emit();
    },
    async load() {
      try {
        const loaded = await transport.load();
        state = { since: loaded.since, marks: { ...loaded.marks, ...state.marks } };
      } catch {
        return;
      }
      const legacy = takeLegacyMarks(now());
      if (Object.keys(legacy).length > 0) {
        state = { ...state, marks: { ...legacy, ...state.marks } };
        queue(legacy);
      }
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const seenItems = createSeenItems();

export const useSeenItems = () =>
  useSyncExternalStore(seenItems.subscribe, seenItems.get, seenItems.get);

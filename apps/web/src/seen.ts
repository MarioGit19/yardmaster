import type { SeenMarks, SeenResponse, SeenUpdate } from '@yardmaster/protocol';
import { useSyncExternalStore } from 'react';
import { api } from './settings/api.js';

/** Marks are sent in one batch, this long after the first of them. */
const FLUSH_MS = 1_000;
/** The list the board kept in this browser's storage before the server held it. */
const LEGACY_KEY = 'yardmaster.seenFailures';

type SeenRestore = NonNullable<SeenUpdate['restore']>;

export interface SeenTransport {
  load(): Promise<SeenResponse>;
  save(marks: SeenMarks, restore?: SeenRestore): Promise<unknown>;
}

export interface SeenItems {
  get(): SeenResponse;
  /** Marks `key` as opened at `at`, here at once and on this browser's session soon after. */
  mark(key: string, at?: number): void;
  /** Marks several at once and returns what puts them back. */
  markAll(marks: SeenMarks): () => void;
  /** False until the browser's record has come back, or failed to. */
  loaded(): boolean;
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
  transport: SeenTransport = {
    load: api.seen,
    save: (marks, restore) => api.markSeen({ marks, ...(restore ? { restore } : {}) }),
  },
  now: () => number = Date.now,
): SeenItems {
  const listeners = new Set<() => void>();
  // Until the server answers, only what happens from now on is news.
  let state: SeenResponse = { since: now(), marks: {} };
  let pending: SeenMarks = {};
  let pendingRestore: SeenRestore = {};
  let loaded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const flush = () => {
    timer = null;
    const marks = pending;
    const restore = pendingRestore;
    pending = {};
    pendingRestore = {};
    // A lost update only means a mark comes back on the next reload.
    const hasRestore = Object.keys(restore).length > 0;
    transport.save(marks, ...(hasRestore ? [restore] : [])).catch(() => {});
  };
  const schedule = () => {
    if (timer === null) timer = setTimeout(flush, FLUSH_MS);
  };
  const queue = (marks: SeenMarks) => {
    Object.assign(pending, marks);
    for (const key of Object.keys(marks)) delete pendingRestore[key];
    schedule();
  };
  const restore = (previous: SeenRestore) => {
    const marks = { ...state.marks };
    for (const [key, at] of Object.entries(previous)) {
      if (at === null) delete marks[key];
      else marks[key] = at;
      delete pending[key];
    }
    state = { ...state, marks };
    Object.assign(pendingRestore, previous);
    schedule();
    emit();
  };
  return {
    get: () => state,
    mark(key, at = now()) {
      if ((state.marks[key] ?? -1) >= at) return;
      state = { ...state, marks: { ...state.marks, [key]: at } };
      queue({ [key]: at });
      emit();
    },
    markAll(marks) {
      const previous: SeenRestore = {};
      for (const key of Object.keys(marks)) previous[key] = state.marks[key] ?? null;
      state = { ...state, marks: { ...state.marks, ...marks } };
      queue(marks);
      emit();
      return () => restore(previous);
    },
    loaded: () => loaded,
    async load() {
      try {
        const record = await transport.load();
        state = { since: record.since, marks: { ...record.marks, ...state.marks } };
      } catch {
        loaded = true;
        emit();
        return;
      }
      loaded = true;
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

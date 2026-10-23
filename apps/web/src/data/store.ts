import {
  type ActivityEvent,
  applyPatch,
  type BoardState,
  emptyBoardState,
  HISTORY_WINDOW_MS,
  type PatchOp,
} from '@c-board/protocol';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { ingestEvents, ingestOutput, type Pulses } from './activity.js';

/**
 * `connecting`: first attempt; `syncing`: socket open, waiting for the snapshot;
 * `live`: snapshot applied, patches flowing; `reconnecting`: waiting to retry;
 * `stopped`: the client was shut down.
 */
export type ConnectionStatus = 'connecting' | 'syncing' | 'live' | 'reconnecting' | 'stopped';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Failed attempts since the last snapshot. */
  attempt: number;
  /** When the next attempt starts (epoch ms), while `reconnecting`. */
  retryAt: number | null;
  /** When the last snapshot arrived. */
  syncedAt: number | null;
}

export interface BoardStoreState {
  board: BoardState;
  /** Whether `board` came from the server (false until the first snapshot). */
  hydrated: boolean;
  connection: ConnectionState;
  /** Recent activity events (the last hour) for the Pulse rail and Transit, oldest first. */
  activity: readonly ActivityEvent[];
  /** Activity levels per project, session and terminal (`activityKey`), DESIGN.md §4.10. */
  pulses: Pulses;
  /** Replaces the whole board, e.g. from a snapshot after (re)connecting. */
  replaceBoard(board: BoardState): void;
  applyOps(ops: readonly PatchOp[], now?: number): void;
  setConnection(connection: Partial<ConnectionState>): void;
  /** `replace` swaps in the server's window (after (re)connecting); otherwise events append. */
  addActivity(events: readonly ActivityEvent[], replace: boolean, now?: number): void;
}

export type BoardStore = StoreApi<BoardStoreState>;

/** Events older than the history window (plus this slack) are dropped from the store. */
export const ACTIVITY_SLACK_MS = 60_000;
export const MAX_ACTIVITY = 5_000;

/**
 * Merges `incoming` into `current` (both oldest first), dropping duplicate ids and events
 * that fell out of the history window. Returns `current` itself when nothing changed.
 */
export function mergeActivity(
  current: readonly ActivityEvent[],
  incoming: readonly ActivityEvent[],
  now: number,
): readonly ActivityEvent[] {
  const cutoff = now - HISTORY_WINDOW_MS - ACTIVITY_SLACK_MS;
  const seen = new Set(current.map((e) => e.id));
  const fresh = incoming.filter((e) => {
    if (e.ts < cutoff || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  const start = current.findIndex((e) => e.ts >= cutoff);
  const kept = start === -1 ? [] : start === 0 ? current : current.slice(start);
  if (fresh.length === 0) return kept.length === current.length ? current : kept;
  const merged = [...kept, ...fresh];
  // Live events almost always arrive in order; sort only when one didn't.
  if (merged.some((e, i) => i > 0 && e.ts < (merged[i - 1] as ActivityEvent).ts)) {
    merged.sort((a, b) => a.ts - b.ts);
  }
  return merged.length > MAX_ACTIVITY ? merged.slice(-MAX_ACTIVITY) : merged;
}

export function createBoardStore(): BoardStore {
  return createStore<BoardStoreState>()((set) => ({
    board: emptyBoardState(),
    hydrated: false,
    connection: { status: 'connecting', attempt: 0, retryAt: null, syncedAt: null },
    activity: [],
    pulses: {},
    replaceBoard: (board) => set({ board, hydrated: true }),
    applyOps: (ops, now = Date.now()) => {
      if (ops.length === 0) return;
      // applyPatch keeps the identity of untouched branches, so entity selectors stay stable.
      set((state) => {
        const board = applyPatch(state.board, ops);
        return { board, pulses: ingestOutput(state.pulses, state.board, board, ops, now) };
      });
    },
    setConnection: (connection) =>
      set((state) => ({ connection: { ...state.connection, ...connection } })),
    addActivity: (events, replace, now = Date.now()) =>
      set((state) => {
        const activity = mergeActivity(replace ? [] : state.activity, events, now);
        if (activity === state.activity) return state;
        // A replay after reconnecting repeats events we already counted; only count new ones.
        const known = new Set(state.activity.map((e) => e.id));
        const fresh = events.filter((e) => !known.has(e.id));
        return { activity, pulses: ingestEvents(state.pulses, fresh, state.board, now) };
      }),
  }));
}

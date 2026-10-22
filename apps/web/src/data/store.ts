import { applyPatch, type BoardState, emptyBoardState, type PatchOp } from '@c-board/protocol';
import { createStore, type StoreApi } from 'zustand/vanilla';

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
  /** Replaces the whole board, e.g. from a snapshot after (re)connecting. */
  replaceBoard(board: BoardState): void;
  applyOps(ops: readonly PatchOp[]): void;
  setConnection(connection: Partial<ConnectionState>): void;
}

export type BoardStore = StoreApi<BoardStoreState>;

export function createBoardStore(): BoardStore {
  return createStore<BoardStoreState>()((set) => ({
    board: emptyBoardState(),
    hydrated: false,
    connection: { status: 'connecting', attempt: 0, retryAt: null, syncedAt: null },
    replaceBoard: (board) => set({ board, hydrated: true }),
    applyOps: (ops) => {
      if (ops.length === 0) return;
      // applyPatch keeps the identity of untouched branches, so entity selectors stay stable.
      set((state) => ({ board: applyPatch(state.board, ops) }));
    },
    setConnection: (connection) =>
      set((state) => ({ connection: { ...state.connection, ...connection } })),
  }));
}

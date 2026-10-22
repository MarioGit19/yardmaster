import type { StreamId } from '@c-board/protocol';
import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { BoardClient, ChunkListener } from './client.js';
import type { BoardStore, BoardStoreState } from './store.js';

interface BoardContextValue {
  client: BoardClient;
  store: BoardStore;
}

const BoardContext = createContext<BoardContextValue | null>(null);

export function BoardProvider({
  client,
  store,
  children,
}: BoardContextValue & { children: ReactNode }) {
  return <BoardContext.Provider value={{ client, store }}>{children}</BoardContext.Provider>;
}

function useBoardContext(): BoardContextValue {
  const value = useContext(BoardContext);
  if (!value) throw new Error('useBoard* hooks need a <BoardProvider>');
  return value;
}

export function useBoardClient(): BoardClient {
  return useBoardContext().client;
}

/** The raw store, for consumers that read it outside React renders (e.g. a canvas loop). */
export function useBoardStore(): BoardStore {
  return useBoardContext().store;
}

/** For selectors that return stored values (entities, connection, flags). */
export function useBoard<T>(selector: (state: BoardStoreState) => T): T {
  return useStore(useBoardContext().store, selector);
}

/** For selectors that build arrays: re-renders only when an element changes. */
export function useBoardList<T>(selector: (state: BoardStoreState) => T[]): T[] {
  return useStore(useBoardContext().store, useShallow(selector));
}

/** For selectors that build a flat object: re-renders only when a field changes. */
export function useBoardShallow<T extends object>(selector: (state: BoardStoreState) => T): T {
  return useStore(useBoardContext().store, useShallow(selector));
}

/**
 * Streams output of `streamId` (null = nothing) into `onChunk`, outside React state,
 * e.g. straight into an xterm instance. The latest `onChunk` is always used.
 */
export function useStream(streamId: StreamId | null, onChunk: ChunkListener): void {
  const { client } = useBoardContext();
  const callback = useRef(onChunk);
  callback.current = onChunk;
  useEffect(() => {
    if (streamId === null) return;
    return client.subscribeStream(streamId, (chunk, info) => callback.current(chunk, info));
  }, [client, streamId]);
}

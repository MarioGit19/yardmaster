import type { BoardState, EditorApp } from '@yardmaster/protocol';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ActionListener } from '../data/index.js';
import { useBoard, useBoardClient } from '../data/index.js';

/** After this long without the window connecting, the pod hints at the extension. */
export const OPENING_HINT_MS = 20_000;
/** And after this long it gives up on the window. */
export const OPENING_GIVE_UP_MS = 90_000;

export interface Opening {
  editor: EditorApp;
  since: number;
}

export type OpeningPhase = 'opening' | 'slow';

/** Projects whose editor was launched from the board and whose window hasn't connected yet. */
export function createOpeningStore() {
  const listeners = new Set<() => void>();
  let value: ReadonlyMap<string, Opening> = new Map();
  const set = (next: Map<string, Opening>) => {
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(projectId: string, opening: Opening) {
      set(new Map(value).set(projectId, opening));
    },
    clear(projectIds: readonly string[]) {
      const next = new Map(value);
      for (const id of projectIds) next.delete(id);
      if (next.size !== value.size) set(next);
    },
  };
}

export const openingStore = createOpeningStore();

/** The project has an editor window connected. */
export function hasWindow(windows: BoardState['windows'], projectId: string): boolean {
  return Object.values(windows).some((w) => w.projectIds.includes(projectId));
}

/** The hint once a launched window is slow to show up on the board. */
export function slowHint(editor: EditorApp): string {
  return `${editor} hasn't connected yet. Is the Yardmaster extension installed in it?`;
}

export function openingPhase(opening: Opening, now: number): OpeningPhase | null {
  const age = now - opening.since;
  if (age >= OPENING_GIVE_UP_MS) return null;
  return age >= OPENING_HINT_MS ? 'slow' : 'opening';
}

/** The pending launches whose window has connected, or that gave up. */
export function settledOpenings(
  openings: ReadonlyMap<string, Opening>,
  windows: BoardState['windows'],
  now: number,
): string[] {
  return [...openings]
    .filter(([id, o]) => hasWindow(windows, id) || openingPhase(o, now) === null)
    .map(([id]) => id);
}

/**
 * Watches every `project.openInEditor` the board sends (pod menu, ⌘K, launch sheet, inspector)
 * and clears it once the window's extension connects. Mounted once, in the app.
 */
export function useEditorLaunches(store = openingStore, now: () => number = Date.now): void {
  const client = useBoardClient();
  const windows = useBoard((s) => s.board.windows);
  const openings = useSyncExternalStore(store.subscribe, store.get);
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  useEffect(() => {
    const listener: ActionListener = (action, result) => {
      if (action.kind !== 'project.openInEditor' || !result.ok) return;
      // An open window only comes to the front: nothing to wait for.
      if (hasWindow(windowsRef.current, action.projectId)) return;
      store.start(action.projectId, { editor: result.editor ?? 'Cursor', since: now() });
    };
    return client.onAction(listener);
  }, [client, store, now]);
  useEffect(() => {
    store.clear(settledOpenings(openings, windows, now()));
  }, [openings, windows, store, now]);
  useEffect(() => {
    if (openings.size === 0) return;
    const timer = setInterval(() => store.clear(settledOpenings(openings, windows, now())), 5_000);
    return () => clearInterval(timer);
  }, [openings, windows, store, now]);
}

/** "Opening in Cursor…" for a project, flipping to the hint once it takes long. */
export function useOpening(
  projectId: string,
  store = openingStore,
): { editor: EditorApp; phase: OpeningPhase } | null {
  const opening = useSyncExternalStore(store.subscribe, () => store.get().get(projectId));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!opening) return;
    setNow(Date.now());
    const wait = opening.since + OPENING_HINT_MS - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [opening]);
  if (!opening) return null;
  const phase = openingPhase(opening, Math.max(now, opening.since));
  return phase ? { editor: opening.editor, phase } : null;
}

/** Mounts `useEditorLaunches` once in the app. */
export function EditorLaunchWatcher(): null {
  useEditorLaunches();
  return null;
}

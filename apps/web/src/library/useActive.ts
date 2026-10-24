import { DEFAULT_IDLE_HIDE_MIN } from '@yardmaster/protocol';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useNow } from '../anim/clock.js';
import { useBoard } from '../data/index.js';
import { boardSettings, useBoardSettings } from '../settings/boardSettings.js';
import { activeKey, closedKey } from './active.js';

/** How often the overview re-checks the idle window when nothing else changes. */
export const ACTIVE_TICK_MS = 15_000;
const MIN_MS = 60_000;

function createOpenedStore() {
  const listeners = new Set<() => void>();
  let value: ReadonlyMap<string, number> = new Map();
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mark(projectId: string, at = Date.now()) {
      value = new Map(value).set(projectId, at);
      for (const listener of listeners) listener();
    },
  };
}

/** Projects the user opened from the board in this tab, and when. */
export const openedProjects = createOpenedStore();

/** The user opened a project from the board (its focus view): it rejoins the overview. */
export const markOpened = (projectId: string) => openedProjects.mark(projectId);

const NO_PINS: readonly string[] = [];

/**
 * The projects the overview shows (F26). Until the server settings load it uses the default idle
 * window and no pins.
 */
export function useActiveProjects(): ReadonlySet<string> {
  const { settings } = useBoardSettings();
  const opened = useSyncExternalStore(openedProjects.subscribe, openedProjects.get);
  const now = useNow(ACTIVE_TICK_MS);
  const pins = settings?.pinnedProjects ?? NO_PINS;
  const pinned = useMemo(() => new Set(pins), [pins]);
  const idleHideMs = (settings?.libraryIdleHideMin ?? DEFAULT_IDLE_HIDE_MIN) * MIN_MS;
  const key = useBoard((s) => activeKey(s.board, { now, idleHideMs, pinned, opened }));
  return useMemo(() => new Set(key === '' ? [] : key.split('\n')), [key]);
}

const NONE: ReadonlySet<string> = new Set();

/** Closed projects with nothing newer since (12.6e): the rail and the phone list leave them out. */
export function useClosedProjects(): ReadonlySet<string> {
  const opened = useSyncExternalStore(openedProjects.subscribe, openedProjects.get);
  const key = useBoard((s) => closedKey(s.board, opened));
  return useMemo(() => (key === '' ? NONE : new Set(key.split('\n'))), [key]);
}

/** A project's pin (the pod menu): pinned projects stay on the overview however quiet. */
export function usePin(projectId: string): { pinned: boolean; toggle: () => void } {
  // The overview loads the settings; a menu per pod only reads them.
  const settings = useSyncExternalStore(boardSettings.subscribe, boardSettings.get);
  const pins = settings?.pinnedProjects ?? NO_PINS;
  const pinned = pins.includes(projectId);
  const toggle = useCallback(() => {
    const next = pinned ? pins.filter((id) => id !== projectId) : [...pins, projectId];
    void boardSettings.update({ pinnedProjects: next }).then((ok) => {
      if (!ok) toast.error(pinned ? 'Could not unpin it' : 'Could not pin it');
    });
  }, [pinned, pins, projectId]);
  return { pinned, toggle };
}

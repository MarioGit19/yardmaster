import type { BoardSettings, BoardSettingsPatch } from '@c-board/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { api } from './api.js';

export interface BoardSettingsStore {
  get(): BoardSettings | null;
  subscribe(listener: () => void): () => void;
  /** Fetches the settings; concurrent calls share one request. Failures keep what was there. */
  load(): Promise<void>;
  /** Applies a patch optimistically; rolls it back and resolves false if the save fails. */
  update(patch: BoardSettingsPatch): Promise<boolean>;
}

/** Settings the server owns, shared by every view that shows or depends on one. */
export function createBoardSettingsStore(io: {
  fetch: () => Promise<BoardSettings>;
  save: (patch: BoardSettingsPatch) => Promise<BoardSettings>;
}): BoardSettingsStore {
  const listeners = new Set<() => void>();
  let value: BoardSettings | null = null;
  let loading: Promise<void> | null = null;
  const set = (next: BoardSettings | null) => {
    if (next === value) return;
    value = next;
    for (const listener of listeners) listener();
  };

  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load() {
      loading ??= io
        .fetch()
        .then(set, () => {})
        .finally(() => {
          loading = null;
        });
      return loading;
    },
    async update(patch) {
      const previous = value;
      if (previous) set({ ...previous, ...patch });
      try {
        set(await io.save(patch));
        return true;
      } catch {
        set(previous);
        return false;
      }
    },
  };
}

export const boardSettings = createBoardSettingsStore({
  fetch: () => api.settings(),
  save: (patch) => api.updateSettings(patch),
});

export interface ServerSettings {
  settings: BoardSettings | null;
  /** Saves a patch; a failure rolls it back and shows `failure` as a toast. */
  update: (patch: BoardSettingsPatch, failure: string) => Promise<void>;
}

const update = async (patch: BoardSettingsPatch, failure: string) => {
  if (!(await boardSettings.update(patch))) toast.error(failure);
};

/** The server settings, fetched on mount so another tab's change shows up here too. */
export function useBoardSettings(): ServerSettings {
  const settings = useSyncExternalStore(boardSettings.subscribe, boardSettings.get);
  useEffect(() => {
    void boardSettings.load();
  }, []);
  return { settings, update };
}

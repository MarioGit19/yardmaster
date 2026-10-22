import { useSyncExternalStore } from 'react';
import { usePreference } from '../prefs.js';
import { redactPreference } from '../settings/prefs.js';

/**
 * Blocks the reader chose to reveal (`row:<id>`, `term:<id>`). Kept in memory only: a reload
 * masks everything again.
 */
const revealed = new Set<string>();
const listeners = new Set<() => void>();

export const reveal = {
  has: (key: string) => revealed.has(key),
  toggle(key: string) {
    if (!revealed.delete(key)) revealed.add(key);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Whether the block under `key` shows masked: the setting is on and it isn't revealed. */
export function useMasked(key: string): boolean {
  const on = usePreference(redactPreference) === 'on';
  const shown = useSyncExternalStore(
    reveal.subscribe,
    () => revealed.has(key),
    () => false,
  );
  return on && !shown;
}

export function useRedactOn(): boolean {
  return usePreference(redactPreference) === 'on';
}

import { useSyncExternalStore } from 'react';

/** Dev overrides for the ambient field, set from `/#/_tokens`. Null follows the live board. */
export interface AmbientOverride {
  energy: number | null;
  attention: boolean | null;
}

let override: AmbientOverride = { energy: null, attention: null };
const listeners = new Set<() => void>();

export const ambientOverride = {
  get: (): AmbientOverride => override,
  set(next: Partial<AmbientOverride>) {
    override = { ...override, ...next };
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useAmbientOverride(): AmbientOverride {
  return useSyncExternalStore(ambientOverride.subscribe, ambientOverride.get, ambientOverride.get);
}

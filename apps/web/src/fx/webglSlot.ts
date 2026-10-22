import { useEffect, useSyncExternalStore } from 'react';

/**
 * The one-WebGL-context rule (DESIGN.md §3 "Third-party effects", §7): an effect that draws with
 * WebGL claims the slot while it is shown, and the ambient field steps back to its CSS field until
 * every claim is released, so the page never holds two contexts.
 */
export interface WebglSlot {
  /** Takes the slot; call the returned function to give it back (idempotent). */
  claim(): () => void;
  claimed(): boolean;
  subscribe(listener: () => void): () => void;
}

export function createWebglSlot(): WebglSlot {
  let claims = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    claim() {
      claims += 1;
      if (claims === 1) notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        claims -= 1;
        if (claims === 0) notify();
      };
    },
    claimed: () => claims > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const webglSlot = createWebglSlot();

/** Holds the slot while `active`. */
export function useWebglClaim(active: boolean, slot: WebglSlot = webglSlot): void {
  useEffect(() => (active ? slot.claim() : undefined), [active, slot]);
}

/** Whether an effect holds the slot (the ambient field then shows its CSS field). */
export function useWebglClaimed(slot: WebglSlot = webglSlot): boolean {
  return useSyncExternalStore(slot.subscribe, slot.claimed, slot.claimed);
}

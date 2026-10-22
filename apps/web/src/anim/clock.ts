import { useCallback, useRef, useSyncExternalStore } from 'react';

// Shared wall clocks: every component asking for the same period shares one timer, and the
// timer stops with its last subscriber.

interface Clock {
  now: number;
  timer: ReturnType<typeof setInterval>;
  listeners: Set<() => void>;
}

const clocks = new Map<number, Clock>();

function subscribe(period: number, listener: () => void): () => void {
  let clock = clocks.get(period);
  if (!clock) {
    const created: Clock = {
      now: Date.now(),
      listeners: new Set(),
      timer: setInterval(() => {
        created.now = Date.now();
        for (const l of [...created.listeners]) l();
      }, period),
    };
    clock = created;
    clocks.set(period, clock);
  }
  clock.listeners.add(listener);
  return () => {
    const current = clocks.get(period);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      clearInterval(current.timer);
      clocks.delete(period);
    }
  };
}

const NEVER = () => () => {};

/** `Date.now()`, refreshed every `period` ms; null keeps the value from the last render. */
export function useNow(period: number | null): number {
  const sub = useCallback(
    (listener: () => void) => (period === null ? NEVER() : subscribe(period, listener)),
    [period],
  );
  const last = useRef(Date.now());
  return useSyncExternalStore(sub, () => {
    if (period !== null) last.current = clocks.get(period)?.now ?? last.current;
    return last.current;
  });
}

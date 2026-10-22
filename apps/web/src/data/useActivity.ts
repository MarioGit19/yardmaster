import { useCallback, useRef, useSyncExternalStore } from 'react';
import { levelAt, levelStep } from './activity.js';
import { useBoard, useBoardStore } from './react.js';
import type { BoardStoreState } from './store.js';

/** While an entity is busy, its step is re-read this often as the level decays. */
const DECAY_CHECK_MS = 500;

/**
 * The entity's activity step (0 = quiet, 1–3 = busy). Re-renders only when the step changes;
 * quiet entities run no timer.
 */
export function useActivityStep(key: string): 0 | 1 | 2 | 3 {
  return useDecaying((s, now) => levelStep(levelAt(s.pulses[key], now)), isBusyStep);
}

const isBusyStep = (step: number) => step > 0;
const hasBusyFlag = (flags: string) => flags.includes('1');

/**
 * A value derived from the store and the clock (activity levels decay with time). Re-reads on
 * every store change and, while `busy(value)`, every `DECAY_CHECK_MS`; the caller re-renders
 * only when the value changes. `busy` must be a stable function.
 */
function useDecaying<T>(
  read: (state: BoardStoreState, now: number) => T,
  busy: (value: T) => boolean,
): T {
  const store = useBoardStore();
  const readRef = useRef(read);
  readRef.current = read;
  const subscribe = useCallback(
    (notify: () => void) => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const sync = () => {
        const active = busy(readRef.current(store.getState(), Date.now()));
        if (active && timer === null) {
          timer = setInterval(() => {
            notify();
            sync();
          }, DECAY_CHECK_MS);
        } else if (!active && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
      const unsubscribe = store.subscribe(() => {
        notify();
        sync();
      });
      sync();
      return () => {
        unsubscribe();
        if (timer !== null) clearInterval(timer);
      };
    },
    [store, busy],
  );
  return useSyncExternalStore(subscribe, () => readRef.current(store.getState(), Date.now()));
}

/** Idle checks (dimming, sleeping) work in minutes: last-activity times are read this coarsely. */
export const LAST_ACTIVITY_STEP_MS = 10_000;

/**
 * When the entity last had an event or output (rounded down to `LAST_ACTIVITY_STEP_MS`, so
 * streaming output doesn't re-render the caller), or null if never.
 */
export function useLastActivity(key: string): number | null {
  return useBoard((s) => coarse(s.pulses[key]?.lastAt));
}

const coarse = (at: number | undefined) =>
  at === undefined ? null : at - (at % LAST_ACTIVITY_STEP_MS);

/** Discrete events seen for the entity: changes once per event. */
export function useEventCount(key: string): number {
  return useBoard((s) => s.pulses[key]?.events ?? 0);
}

/** When the entity last finished a turn. */
export function useDoneAt(key: string): number | null {
  return useBoard((s) => s.pulses[key]?.doneAt ?? null);
}

/**
 * Which of `keys` are busy right now, as a string of 0/1 flags (a primitive, so the caller only
 * re-renders when one flips). Re-checks while any is busy.
 */
export function useBusyFlags(keys: readonly string[]): string {
  return useDecaying(
    (s, now) =>
      keys.map((key) => (levelStep(levelAt(s.pulses[key], now)) > 0 ? '1' : '0')).join(''),
    hasBusyFlag,
  );
}

/** The newest activity among `keys`, as coarse as `useLastActivity`, or null. */
export function useLatestActivity(keys: readonly string[]): number | null {
  return useBoard((s) => {
    let latest: number | undefined;
    for (const key of keys) {
      const at = s.pulses[key]?.lastAt;
      if (at !== undefined && (latest === undefined || at > latest)) latest = at;
    }
    return coarse(latest);
  });
}

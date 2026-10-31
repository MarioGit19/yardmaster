import { createPreference, type KeyValueStorage } from '../prefs.js';

export const RECAP_AFTER = ['10', '20', '60', 'off'] as const;
export type RecapAfter = (typeof RECAP_AFTER)[number];

export const RECAP_AFTER_LABEL: Record<RecapAfter, string> = {
  '10': '10 min',
  '20': '20 min',
  '60': '1 hour',
  off: 'Off',
};

/** How long the board stays hidden or untouched before coming back shows a recap. Per device. */
export const recapAfterPreference = createPreference<RecapAfter>(
  'yardmaster.recap.after',
  RECAP_AFTER,
  '20',
);

export const LAST_ACTIVE_KEY = 'yardmaster.recap.lastActive';
/** Activity reaches storage this often at most, and on leaving the page. */
const WRITE_MS = 30_000;

export interface AwayClock {
  /** The user is here. Returns when they were last here, if that was long enough ago. */
  touch(): number | null;
  /** The page is going away: keeps the last activity that hasn't been written yet. */
  flush(): void;
}

/** Kept in storage, so a closed tab or a killed phone app still knows when it was last used. */
export function createAwayClock(
  storage: KeyValueStorage | undefined,
  afterMs: () => number | null,
  now: () => number = Date.now,
): AwayClock {
  let latest: number | null = null;
  const read = () => {
    try {
      const stored = Number(storage?.getItem(LAST_ACTIVE_KEY) ?? Number.NaN);
      return Number.isFinite(stored) ? stored : null;
    } catch {
      return null;
    }
  };
  const write = (at: number) => {
    try {
      storage?.setItem(LAST_ACTIVE_KEY, String(at));
    } catch {
      // Storage can be full or disabled: there just won't be a recap.
    }
  };
  return {
    touch() {
      const at = now();
      const last = read();
      const after = afterMs();
      const away = last !== null && after !== null && at - last >= after ? last : null;
      latest = at;
      if (away !== null || last === null || at - last >= WRITE_MS) write(at);
      return away;
    },
    flush() {
      if (latest !== null && latest > (read() ?? 0)) write(latest);
    },
  };
}

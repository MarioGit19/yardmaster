import { routes } from '../routes.js';

/** The phone shell's bottom tabs (DESIGN.md §11), in bar order. */
export const PHONE_TABS = ['overview', 'projects', 'attention', 'pulse', 'more'] as const;
export type PhoneTab = (typeof PHONE_TABS)[number];

export const PHONE_TAB_HREF: Record<PhoneTab, string> = {
  overview: routes.overview,
  projects: routes.projects,
  attention: routes.attention,
  pulse: routes.pulse,
  more: routes.more,
};

/** A project's workspace (the focus view), any session or terminal in it included. */
export const isWorkspace = (location: string) => location.startsWith('/p/');

/** The tab a location belongs to: Settings sits under More; a workspace or the guide, none. */
export function phoneTabFor(location: string): PhoneTab | null {
  if (location === routes.settings) return 'more';
  for (const tab of PHONE_TABS) if (PHONE_TAB_HREF[tab] === location) return tab;
  return null;
}

type HistoryLike = Pick<History, 'state' | 'replaceState'> & Partial<Pick<History, 'pushState'>>;

const KEY = 'yardmasterIndex';

/**
 * Where each history entry of this page load sits, so a workspace's Back can return to the tab it
 * was opened from by going back (`history.go(-n)`), the same as the back gesture would, rather
 * than pushing the overview on top. Each entry is stamped with its index in `history.state` the
 * first time it is seen; a back or forward step reads the stamp it already has.
 */
export function createHistoryTrack(history: HistoryLike) {
  let started = false;
  let current = 0;
  const seen = new Map<number, string>();
  return {
    visit(location: string) {
      const state: unknown = history.state;
      const stamped =
        state &&
        typeof state === 'object' &&
        typeof (state as Record<string, unknown>)[KEY] === 'number'
          ? ((state as Record<string, unknown>)[KEY] as number)
          : null;
      let index = stamped;
      if (index === null) {
        index = started ? current + 1 : 0;
        try {
          history.replaceState({ ...(state as object | null), [KEY]: index }, '');
        } catch {
          // A sandboxed frame can refuse; Back then falls back to the overview.
        }
        // A new entry drops whatever was ahead of it.
        for (const key of seen.keys()) if (key > index) seen.delete(key);
      }
      started = true;
      current = index;
      seen.set(index, location);
    },
    /** The location one entry back, if this page load has seen it. */
    previous(): string | null {
      return seen.get(current - 1) ?? null;
    },
    /**
     * Slides `below` under the current entry: the entry becomes `below` and the current location
     * is pushed again on top, so the next back lands on `below`. A deep link into a workspace's
     * item page puts the project hub under it this way (DESIGN.md §11). The URL ends where it
     * was, so the router sees no change.
     */
    placeBelow(below: string) {
      const here = seen.get(current);
      if (here === undefined || here === below || !history.pushState) return;
      const state: unknown = history.state;
      try {
        history.replaceState({ ...(state as object | null), [KEY]: current }, '', `#${below}`);
        history.pushState({ [KEY]: current + 1 }, '', `#${here}`);
      } catch {
        return;
      }
      for (const key of seen.keys()) if (key > current) seen.delete(key);
      seen.set(current, below);
      current += 1;
      seen.set(current, here);
    },
    /**
     * How many steps back (a negative `history.go` delta) reach the nearest entry outside a
     * workspace, or null when this page load has none (a direct link into the workspace).
     */
    stepsToLeaveWorkspace(): number | null {
      for (let index = current - 1; index >= 0; index--) {
        const location = seen.get(index);
        if (location === undefined) return null;
        if (!isWorkspace(location)) return index - current;
      }
      return null;
    },
  };
}

export const historyTrack = createHistoryTrack(
  typeof window === 'undefined'
    ? { state: null, replaceState: () => {} }
    : {
        get state() {
          return window.history.state;
        },
        replaceState: (data, unused, url) => window.history.replaceState(data, unused, url),
        pushState: (data, unused, url) => window.history.pushState(data, unused, url),
      },
);

/** Leaves the workspace: back through history to the tab it came from, else to the overview. */
export function leaveWorkspace(navigate: (to: string, options?: { replace?: boolean }) => void) {
  const steps = historyTrack.stepsToLeaveWorkspace();
  if (steps !== null) window.history.go(steps);
  else navigate(routes.overview, { replace: true });
}

/**
 * The one shared `requestAnimationFrame` loop for orbs, sparklines and other canvas motion
 * (DESIGN.md §7). Callbacks register once and toggle `active`; the loop only runs while at least
 * one active callback exists and the page is visible, so an idle board costs nothing.
 */

/** `now` is the rAF timestamp in ms; `dt` is ms since this callback's previous frame (0 on its first). */
export type FrameCallback = (now: number, dt: number) => void;

export interface FrameHandle {
  setActive(active: boolean): void;
  remove(): void;
}

export interface Scheduler {
  add(callback: FrameCallback, active?: boolean): FrameHandle;
  /** Paused schedulers keep their registrations but request no frames. */
  setPaused(paused: boolean): void;
  /** Number of registered callbacks, active or not. */
  readonly size: number;
  /** Number of callbacks that receive frames while running. */
  readonly activeCount: number;
  /** Whether a frame is currently requested. */
  readonly running: boolean;
}

export interface SchedulerHost {
  request(callback: (now: number) => void): number;
  cancel(id: number): void;
}

/** A long stall (busy main thread, debugger) never lurches animations forward by more than this. */
export const MAX_DT = 100;

interface Entry {
  callback: FrameCallback;
  active: boolean;
  last: number | null;
}

export function createScheduler(host: SchedulerHost): Scheduler {
  const entries = new Set<Entry>();
  let active = 0;
  let paused = false;
  let frameId: number | null = null;

  const shouldRun = () => active > 0 && !paused;

  const sync = () => {
    if (shouldRun() && frameId === null) {
      frameId = host.request(tick);
    } else if (!shouldRun() && frameId !== null) {
      host.cancel(frameId);
      frameId = null;
    }
  };

  function tick(now: number) {
    frameId = null;
    // A snapshot, so callbacks may add or remove registrations mid-frame.
    for (const entry of [...entries]) {
      if (!entry.active || !entries.has(entry)) continue;
      const dt = entry.last === null ? 0 : Math.min(MAX_DT, Math.max(0, now - entry.last));
      entry.last = now;
      try {
        entry.callback(now, dt);
      } catch (error) {
        console.error('[yardmaster] frame callback failed', error);
      }
    }
    sync();
  }

  const setPaused = (next: boolean) => {
    if (next === paused) return;
    paused = next;
    // Resuming restarts every clock, so the first frame back has dt 0.
    if (!paused) for (const entry of entries) entry.last = null;
    sync();
  };

  return {
    add(callback, initiallyActive = true) {
      const entry: Entry = { callback, active: false, last: null };
      entries.add(entry);
      const handle: FrameHandle = {
        setActive(next) {
          if (!entries.has(entry) || next === entry.active) return;
          entry.active = next;
          entry.last = null;
          active += next ? 1 : -1;
          sync();
        },
        remove() {
          if (!entries.has(entry)) return;
          if (entry.active) active -= 1;
          entries.delete(entry);
          sync();
        },
      };
      handle.setActive(initiallyActive);
      return handle;
    },
    setPaused,
    get size() {
      return entries.size;
    },
    get activeCount() {
      return active;
    },
    get running() {
      return frameId !== null;
    },
  };
}

let shared: Scheduler | null = null;

/** The app-wide scheduler, paused while the tab is hidden. */
export function frameScheduler(): Scheduler {
  if (shared) return shared;
  const scheduler = createScheduler({
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  });
  if (typeof document !== 'undefined') {
    const onVisibility = () => scheduler.setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
  }
  shared = scheduler;
  return scheduler;
}

import { SLEEP_AFTER_MS } from '../crew/model.js';
import { moment } from '../motion.js';
import type { Tone } from '../status.js';

// Pod-level activity signals, DESIGN.md §4.10.

/** A pod with nothing going on for this long dims to 70%. */
export const DIM_AFTER_MS = SLEEP_AFTER_MS;
/** A finished turn older than this when it reaches the pod is history, not news: no sweep. */
export const SWEEP_FRESH_MS = 3_000;
export const SWEEP_MS = moment.sweep * 1000;

/** Degrees per second of the activity border's light: faster the more is going on. */
export function borderSpeed(level: number, working: number): number {
  const clamped = Math.min(1, Math.max(0, level));
  return 36 + 200 * clamped + 40 * Math.min(3, Math.max(0, working));
}

/** The border light's opacity for a level: always visible while it runs, brighter when busy. */
export function borderOpacity(level: number): number {
  return 0.35 + 0.6 * Math.min(1, Math.max(0, level));
}

/** Eases `current` toward `target` over ~`ms`, frame-rate independent. */
export function approach(current: number, target: number, dt: number, ms = 600): number {
  return target + (current - target) * Math.exp(-dt / ms);
}

/**
 * Whether the pod dims: nothing needs you or works (tone idle/ok), nothing crashed, and the
 * newest activity is at least five minutes old.
 */
export function isDimmed(
  tone: Tone,
  crashed: boolean,
  lastActivity: number | null,
  now: number,
): boolean {
  if (crashed || (tone !== 'idle' && tone !== 'ok')) return false;
  return lastActivity === null || now - lastActivity >= DIM_AFTER_MS;
}

/** Whether a turn that finished at `doneAt` should sweep the pod now. */
export function isFreshDone(doneAt: number | null, seen: number | null, now: number): boolean {
  return doneAt !== null && doneAt !== seen && now - doneAt < SWEEP_FRESH_MS;
}

import type { Transition } from 'motion/react';
import { createPreference, useMediaQuery, usePreference } from './prefs.js';

/** DESIGN.md §3. */
export const spring = {
  /** Buttons, chips, toggles. */
  snappy: { type: 'spring', stiffness: 520, damping: 38, mass: 0.8 },
  /** Panels, layout changes. */
  smooth: { type: 'spring', stiffness: 260, damping: 30 },
  /** Ambient, large surfaces. */
  gentle: { type: 'spring', stiffness: 120, damping: 20 },
} as const satisfies Record<string, Transition>;

/** Seconds. Mirrored in CSS as `--dur-fast/base/slow` (tokens.css); `motion.test.ts` keeps them equal. */
export const dur = { fast: 0.12, base: 0.22, slow: 0.42 } as const;

/**
 * Seconds. The named exceptions to `dur` (DESIGN.md §3 rule 9), mirrored as `--dur-<name>`:
 * the attention ripple, the turn-finished sweep, a quiet pod stepping back, an event's spark along
 * the pod's hairline (it shares the ripple's length) and the ambient field's energy cross-fade.
 */
export const moment = {
  ripple: 0.9,
  sweep: 0.6,
  dim: 0.8,
  spark: 0.9,
  ambient: 1.2,
  /** The Grid's dive down a pipeline into a node (and back out), and the cockpit's phase-in. */
  dive: 0.9,
  phase: 0.4,
} as const;

/**
 * Seconds. Loop periods (one cycle at rate 1), mirrored as `--dur-<name>`: the skeleton, progress
 * and shimmer sweeps, the HUD spinner, the composer caret, onboarding's listening ring, a
 * waiting pod's and an idle orb's breathing, a running dot's pulse, a lane's comet, and how long
 * a looping rate change (`useRateLoop`) or a new Pulse dot's fly-in takes to land. `expand` is
 * the orb easing back to size after compacting.
 */
export const loop = {
  skeleton: 1.6,
  spin: 0.9,
  progress: 1.4,
  shimmer: 2.4,
  caret: 1.1,
  listen: 2.4,
  breathe: 2.4,
  orb: 4,
  pulse: 1.6,
  comet: 2.4,
  ramp: 0.5,
  fly: 0.3,
  expand: 0.3,
  /** Grid packets crossing a pipeline (grid/map.ts `packetFlow`): calm, busy, peak. */
  packetCalm: 2.4,
  packetBusy: 1.8,
  packetPeak: 1.1,
} as const;

export const ease = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/**
 * A transform animate target that holds still at Reduced. Motion's `reducedMotion` only drops
 * `x`/`y`/`scale`-style keys, not a whole transform string, so every `transform:` target in an
 * `initial`/`animate`/`exit` goes through this (or `slide`); `motion.test.ts` enforces it.
 */
export const move = (still: boolean, transform: string) => (still ? 'none' : transform);

/**
 * A vertical slide as a full transform string, which keeps it on the compositor while the board
 * streams; `still` (Reduced) keeps it in place so only opacity changes.
 */
export const slide = (still: boolean, y: string) => move(still, `translateY(${y})`);

/**
 * A tab indicator's hand-off: it glides to a clicked tab but snaps for keyboard navigation, where
 * the eye is already on the focus ring and a glide per arrow press lags behind.
 */
export const tabGlide = (byKeyboard: boolean): Transition =>
  byKeyboard ? { duration: 0 } : spring.snappy;

export const MOTION_SETTINGS = ['system', 'full', 'reduced', 'off'] as const;
export type MotionSetting = (typeof MOTION_SETTINGS)[number];
export type MotionLevel = Exclude<MotionSetting, 'system'>;

export const PREFERS_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** The next setting in the HUD toggle's cycle. */
export const nextMotion = (setting: MotionSetting): MotionSetting =>
  MOTION_SETTINGS[(MOTION_SETTINGS.indexOf(setting) + 1) % MOTION_SETTINGS.length] ?? 'system';

export const motionPreference = createPreference<MotionSetting>(
  'cboard.motion',
  MOTION_SETTINGS,
  'system',
);

/** "system" follows the OS: reduced when the user asked for less motion, full otherwise. */
export function resolveMotionLevel(setting: MotionSetting, osPrefersReduced: boolean): MotionLevel {
  if (setting === 'system') return osPrefersReduced ? 'reduced' : 'full';
  return setting;
}

export function useMotionLevel(): MotionLevel {
  const setting = usePreference(motionPreference);
  const osPrefersReduced = useMediaQuery(PREFERS_REDUCED_MOTION);
  return resolveMotionLevel(setting, osPrefersReduced);
}

/**
 * Sets `data-motion` before React's first paint (like `applyInitialTheme`), so Reduced and Off
 * never see a frame of Full CSS motion. `MotionRoot` keeps it current afterwards.
 */
export function applyInitialMotion(root: HTMLElement = document.documentElement): MotionLevel {
  const osPrefersReduced = globalThis.matchMedia?.(PREFERS_REDUCED_MOTION).matches ?? false;
  const level = resolveMotionLevel(motionPreference.get(), osPrefersReduced);
  root.dataset.motion = level;
  return level;
}

/**
 * Motion settings for a level. Reduced keeps opacity cross-fades but drops transform and layout
 * movement; off skips every Motion animation.
 */
export function motionConfigFor(level: MotionLevel): {
  reducedMotion: 'always' | 'never';
  skipAnimations: boolean;
} {
  return { reducedMotion: level === 'full' ? 'never' : 'always', skipAnimations: level === 'off' };
}

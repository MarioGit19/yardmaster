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

/** Seconds. */
export const dur = { fast: 0.12, base: 0.22, slow: 0.42 } as const;

export const ease = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/**
 * A vertical slide as a full transform string, which keeps it on the compositor while the board
 * streams; `still` (Reduced) keeps it in place so only opacity changes.
 */
export const slide = (still: boolean, y: string) => `translateY(${still ? '0%' : y})`;

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
 * Motion settings for a level. Reduced keeps opacity cross-fades but drops transform and layout
 * movement; off skips every Motion animation.
 */
export function motionConfigFor(level: MotionLevel): {
  reducedMotion: 'always' | 'never';
  skipAnimations: boolean;
} {
  return { reducedMotion: level === 'full' ? 'never' : 'always', skipAnimations: level === 'off' };
}

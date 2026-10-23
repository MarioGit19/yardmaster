import type { SessionStatus, ToolFamily } from '@c-board/protocol';
import { dur, loop, moment } from '../motion.js';

/** The orb's visual states, DESIGN.md §4.2. */
export const ORB_STATES = [
  'idle',
  'working',
  'tool',
  'waiting',
  'error',
  'compacting',
  'ended',
] as const;
export type OrbState = (typeof ORB_STATES)[number];

export function orbStateFor(status: SessionStatus): OrbState {
  switch (status.kind) {
    case 'idle':
      return 'idle';
    case 'working':
      return 'working';
    case 'tool':
      return 'tool';
    case 'waiting_permission':
    case 'waiting_input':
      return 'waiting';
    case 'error':
      return 'error';
    case 'compacting':
      return 'compacting';
    case 'unknown':
      return status.alive ? 'idle' : 'ended';
    case 'ended':
    case 'interrupted':
      return 'ended';
  }
}

/**
 * One-shot effects played when the orb enters a state (DESIGN.md §3 rules 4–6). `expand` eases
 * a compacted orb back to full size instead of snapping.
 */
export type OrbEffect = 'ripple' | 'glitch' | 'sweep' | 'expand';

/** Seconds. */
export const EFFECT_DURATION: Record<OrbEffect, number> = {
  ripple: moment.ripple,
  glitch: dur.fast,
  sweep: moment.sweep,
  expand: loop.expand,
};

export function enterEffect(previous: OrbState | null, next: OrbState): OrbEffect | null {
  if (previous === null || previous === next) return null;
  if (next === 'waiting') return 'ripple';
  if (next === 'error') return 'glitch';
  if (next === 'idle' && (previous === 'working' || previous === 'tool')) return 'sweep';
  if (previous === 'compacting') return 'expand';
  return null;
}

/**
 * Whether a state needs frame callbacks. Idle breathes through a CSS transform, and error and
 * ended are still, so those draw once and register nothing.
 */
export function orbAnimates(state: OrbState, satellites: number): boolean {
  if (satellites > 0 && state !== 'ended') return true;
  return state === 'working' || state === 'tool' || state === 'waiting' || state === 'compacting';
}

/** Particle color token per tool family: Bash cyan, edits violet, reads blue, web teal, Task pink. */
export const FAMILY_TOKEN: Record<ToolFamily, string> = {
  bash: '--st-tool',
  edit: '--orb-edit',
  read: '--orb-read',
  search: '--orb-read',
  web: '--orb-web',
  task: '--orb-task',
  todo: '--text-2',
  other: '--text-2',
};

/** 3–6 orbiting particles, stable per tool name so the same tool always looks the same. */
export function particleCount(tool: string | null): number {
  if (!tool) return 4;
  let hash = 0;
  for (let i = 0; i < tool.length; i++) hash = (hash * 31 + tool.charCodeAt(i)) >>> 0;
  return 3 + (hash % 4);
}

/** Satellites drawn for running subagents; more than this reads as noise at 28 px. */
export const MAX_SATELLITES = 4;

/** 0..1 of the countdown elapsed, or null without a timeout. */
export function countdownProgress(
  countdown: { startedAt: number; endsAt: number } | null | undefined,
  now: number,
): number | null {
  if (!countdown) return null;
  const span = countdown.endsAt - countdown.startedAt;
  if (!(span > 0)) return 1;
  return Math.min(1, Math.max(0, (now - countdown.startedAt) / span));
}

/**
 * The countdown re-timed to run out `ms` from `now`, continuing from where it is: an approval that
 * expires early lets its ring finish instead of vanishing mid-way.
 */
export function finishCountdown(
  countdown: { startedAt: number; endsAt: number },
  now: number,
  ms: number,
): { startedAt: number; endsAt: number } {
  const done = countdownProgress(countdown, now) ?? 1;
  if (done >= 1) return countdown;
  const span = ms / (1 - done);
  return { startedAt: now - done * span, endsAt: now + ms };
}

const STATE_LABEL: Record<OrbState, string> = {
  idle: 'Idle',
  working: 'Thinking',
  tool: 'Using a tool',
  waiting: 'Waiting for you',
  error: 'Error',
  compacting: 'Compacting',
  ended: 'Ended',
};

export function orbLabel(state: OrbState, tool: string | null, satellites: number): string {
  const base = state === 'tool' && tool ? `Using ${tool}` : STATE_LABEL[state];
  if (satellites <= 0) return base;
  return `${base}, ${satellites} subagent${satellites === 1 ? '' : 's'}`;
}

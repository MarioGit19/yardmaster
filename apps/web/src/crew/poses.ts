import type { Transition, Variants } from 'motion/react';
import { dur, ease, spring } from '../motion.js';
import type { MascotState } from './model.js';

// Poses in viewBox units (0–100); the body layer converts them to CSS px for its size.
// Arms hang from the shoulder: positive rotation swings the left arm out, negative the right.

export interface Pose {
  body: { y: number; rotate: number; scale: number; x?: number[] };
  armL: number;
  armR: number | number[];
  /** `scale` above 1 opens the eyes wide, facing the viewer. */
  eyes: { x: number; y: number; scale?: number };
}

/** The crew states plus `drawing`, a session standing at the Office whiteboard (§10.3). */
export type CrewPose = MascotState | 'drawing';

export const POSES: Record<CrewPose, Pose> = {
  sleeping: { body: { y: 3, rotate: 0, scale: 0.98 }, armL: 4, armR: -4, eyes: { x: 0, y: 2 } },
  idle: { body: { y: 0, rotate: 0, scale: 1 }, armL: 10, armR: -10, eyes: { x: 0, y: 0 } },
  watching: { body: { y: 1, rotate: -5, scale: 1 }, armL: 22, armR: -22, eyes: { x: -3, y: 2 } },
  // Left hand raised to the visor, eyes up.
  thinking: { body: { y: 0, rotate: 3, scale: 1 }, armL: -150, armR: -10, eyes: { x: 3, y: -4 } },
  typing: { body: { y: 3, rotate: 0, scale: 0.98 }, armL: -30, armR: 30, eyes: { x: 0, y: 4 } },
  reading: { body: { y: 1, rotate: 0, scale: 1 }, armL: -42, armR: 42, eyes: { x: 0, y: 3 } },
  // Presses a key once, then lifts the hand to watch the output.
  running: {
    body: { y: 0, rotate: 3, scale: 1 },
    armL: 10,
    armR: [-10, 34, 14],
    eyes: { x: 4, y: 2 },
  },
  delegating: { body: { y: 0, rotate: 5, scale: 1 }, armL: 10, armR: -95, eyes: { x: 4, y: 0 } },
  // Turns to face the viewer: square on, eyes centred and wide.
  waiting: {
    body: { y: -1, rotate: 0, scale: 1.04 },
    armL: 12,
    armR: -165,
    eyes: { x: 0, y: 0, scale: 1.18 },
  },
  // A quick shake on entry.
  error: {
    body: { y: 0, rotate: 0, scale: 1, x: [0, -3, 3, -2, 2, 0] },
    armL: 26,
    armR: -26,
    eyes: { x: 0, y: 1 },
  },
  done: { body: { y: -4, rotate: 0, scale: 1 }, armL: 155, armR: -155, eyes: { x: 0, y: -3 } },
  // Turned toward a board on its right, marker hand raised to it.
  drawing: { body: { y: 0, rotate: 4, scale: 1 }, armL: 12, armR: -118, eyes: { x: 5, y: -2 } },
};

const SHAKE: Transition = { duration: dur.base, ease: ease.out };
const PRESS: Transition = { duration: dur.slow, times: [0, 0.35, 1], ease: ease.out };

/**
 * Motion variants for a pose table: a body layer (HTML, so its offsets scale from viewBox units
 * to the rendered size), the two arms turning about the shoulder, and the eyes (an HTML layer
 * spanning the mascot, so viewBox units are percentages).
 */
export function poseVariants<S extends string>(poses: Record<S, Pose>) {
  function variants<T>(pick: (pose: Pose) => T): Variants {
    const out: Variants = {};
    for (const state of Object.keys(poses) as S[])
      out[state] = pick(poses[state]) as Variants[string];
    return out;
  }
  return {
    body(size: number): Variants {
      const unit = size / 100;
      return variants(({ body }) => ({
        y: body.y * unit,
        rotate: body.rotate,
        scale: body.scale,
        x: body.x ? body.x.map((v) => v * unit) : 0,
        transition: body.x ? { default: spring.smooth, x: SHAKE } : spring.smooth,
      }));
    },
    armL: variants(({ armL }) => ({ rotate: armL, transition: spring.smooth })),
    armR: variants(({ armR }) =>
      Array.isArray(armR)
        ? { rotate: [null, ...armR.slice(1)], transition: PRESS }
        : { rotate: armR, transition: spring.smooth },
    ),
    eyes: variants(({ eyes }) => ({
      x: `${eyes.x}%`,
      y: `${eyes.y}%`,
      scale: eyes.scale ?? 1,
      transition: spring.smooth,
    })),
  };
}

const crew = poseVariants(POSES);

export const bodyVariants = crew.body;
export const armLVariants = crew.armL;
export const armRVariants = crew.armR;
export const eyeVariants = crew.eyes;

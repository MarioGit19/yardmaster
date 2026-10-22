import { motion } from 'motion/react';
import { dur, ease, useMotionLevel } from '../motion.js';

/**
 * A green check in a ring, for a 16 × 16 `<svg>`: a finished todo, an allowed request. With `draw`
 * the stroke draws in (DESIGN.md §4.6); at Reduced it fades, at Off it is simply there.
 */
export function DrawnCheck({ draw }: { draw: boolean }) {
  const level = useMotionLevel();
  const initial =
    !draw || level === 'off' ? false : level === 'full' ? { pathLength: 0 } : { opacity: 0 };
  return (
    <>
      <circle cx="8" cy="8" r="6.5" className="fill-st-ok/15 stroke-st-ok" />
      <motion.path
        d="M5.2 8.2l1.9 1.9 3.7-4"
        className="stroke-st-ok"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={initial}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: dur.base, delay: dur.fast, ease: ease.out }}
      />
    </>
  );
}

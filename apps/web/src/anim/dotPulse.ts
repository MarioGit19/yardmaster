import { ease, loop } from '../motion.js';
import type { RateLoopSpec } from './useRateLoop.js';

/**
 * A ring pulsing out of a small status dot (a streaming lane's uptime dot, a running tool), for
 * `useRateLoop` on the dot's `::after`. Only runs at Full; Reduced and Off show the plain dot.
 */
export const DOT_PULSE: RateLoopSpec = {
  keyframes: [
    // motion-still: only runs at Full; Reduced hides the pulse.
    { transform: 'scale(1)', opacity: 0.55 },
    // motion-still: as above.
    { transform: 'scale(2.8)', opacity: 0 },
  ],
  durationMs: loop.pulse * 1000,
  easing: `cubic-bezier(${ease.out.join(', ')})`,
  pseudoElement: '::after',
};

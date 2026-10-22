import { SAMPLES, type SampleRing } from './throughput.js';

/** Below this many bytes per sample the scale stops shrinking, so a trickle stays low. */
export const SCALE_FLOOR = 1_024;
/** Log-scale knee: a single short log line already shows, a build log doesn't clip. */
const KNEE = 32;

/** 0..1 height for a sample against the window's peak. */
export function sparkLevel(value: number, peak: number): number {
  if (value <= 0) return 0;
  const top = Math.max(peak, SCALE_FLOOR);
  return Math.min(1, Math.log1p(value / KNEE) / Math.log1p(top / KNEE));
}

/** The horizontal distance between two samples, for a sparkline `width` px wide. */
export const sparkStep = (width: number) => width / (SAMPLES - 2);

/**
 * Canvas points for the ring, oldest at x = 0. The newest point sits one step past `width`,
 * so sliding the canvas left by one step over a sample period reveals it.
 */
export function sparkPoints(
  ring: SampleRing,
  width: number,
  height: number,
  inset = 1.5,
): Array<[number, number]> {
  const step = sparkStep(width);
  const peak = ring.max();
  const span = Math.max(0, height - inset * 2);
  const points: Array<[number, number]> = [];
  for (let i = 0; i < SAMPLES; i++) {
    points.push([i * step, height - inset - sparkLevel(ring.at(i), peak) * span]);
  }
  return points;
}

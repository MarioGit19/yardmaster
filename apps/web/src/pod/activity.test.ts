import { describe, expect, it } from 'vitest';
import {
  approach,
  borderOpacity,
  borderSpeed,
  DIM_AFTER_MS,
  isDimmed,
  isFreshDone,
} from './activity.js';

const NOW = 1_760_000_000_000;

describe('pod activity', () => {
  it('spins the border faster with more activity', () => {
    expect(borderSpeed(0.2, 0)).toBeLessThan(borderSpeed(0.9, 0));
    expect(borderSpeed(0.5, 1)).toBeLessThan(borderSpeed(0.5, 3));
    expect(borderSpeed(5, 9)).toBe(borderSpeed(1, 3));
    expect(borderOpacity(0)).toBeGreaterThan(0);
    expect(borderOpacity(1)).toBeLessThanOrEqual(1);
  });

  it('eases toward a target without overshooting', () => {
    expect(approach(0, 100, 0)).toBe(0);
    const step = approach(0, 100, 16);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(100);
    expect(approach(0, 100, 10_000)).toBeCloseTo(100);
  });

  it('dims quiet pods after five minutes, never ones that need you', () => {
    expect(isDimmed('idle', false, NOW - DIM_AFTER_MS + 1, NOW)).toBe(false);
    expect(isDimmed('idle', false, NOW - DIM_AFTER_MS, NOW)).toBe(true);
    expect(isDimmed('idle', false, null, NOW)).toBe(true);
    expect(isDimmed('wait', false, null, NOW)).toBe(false);
    expect(isDimmed('work', false, null, NOW)).toBe(false);
    expect(isDimmed('idle', true, null, NOW)).toBe(false);
  });

  it('sweeps once per fresh finished turn', () => {
    expect(isFreshDone(NOW - 100, null, NOW)).toBe(true);
    expect(isFreshDone(NOW - 100, NOW - 100, NOW)).toBe(false);
    expect(isFreshDone(NOW - 60_000, null, NOW)).toBe(false);
    expect(isFreshDone(null, null, NOW)).toBe(false);
  });
});

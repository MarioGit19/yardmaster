import { describe, expect, it } from 'vitest';
import { drawOrb, type OrbFrame, type OrbPalette } from './render.js';

/** A 2D context that records gradient allocations and ignores everything else. */
function fakeContext() {
  const stats = { gradients: 0 };
  const gradient = () => {
    stats.gradients++;
    return { addColorStop() {} };
  };
  const ctx = new Proxy(
    { createRadialGradient: gradient, createLinearGradient: gradient } as Record<string, unknown>,
    {
      get: (target, key: string) => (key in target ? target[key] : () => {}),
      set: (target, key: string, value) => {
        target[key] = value;
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, stats };
}

const palette: OrbPalette = {
  status: [120, 90, 240],
  accent: [40, 200, 180],
  family: [240, 160, 40],
  satellite: [90, 160, 250],
  ok: [60, 200, 120],
  base: [10, 12, 16],
  light: false,
};

const frame = (time: number, over: Partial<OrbFrame> = {}): OrbFrame => ({
  state: 'tool',
  size: 40,
  time,
  stateTime: 2 + time,
  effect: null,
  particles: 5,
  satellites: 3,
  countdown: null,
  moving: true,
  ...over,
});

describe('drawOrb', () => {
  it('reuses its gradients from frame to frame while particles and satellites move', () => {
    const { ctx, stats } = fakeContext();
    drawOrb(ctx, frame(0), palette);
    const first = stats.gradients;
    expect(first).toBeGreaterThan(0);
    for (let i = 1; i <= 30; i++) drawOrb(ctx, frame(i / 30), palette);
    expect(stats.gradients).toBe(first);
  });

  it('reuses them through the waiting breath, and builds new ones for a new state', () => {
    const { ctx, stats } = fakeContext();
    drawOrb(ctx, frame(0, { state: 'waiting' }), palette);
    const first = stats.gradients;
    for (let i = 1; i <= 30; i++) drawOrb(ctx, frame(i / 10, { state: 'waiting' }), palette);
    expect(stats.gradients).toBe(first);
    drawOrb(ctx, frame(4, { state: 'working' }), palette);
    expect(stats.gradients).toBeGreaterThan(first);
  });
});

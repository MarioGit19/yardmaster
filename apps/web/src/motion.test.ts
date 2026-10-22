import { describe, expect, it } from 'vitest';
import { dur, ease, motionConfigFor, resolveMotionLevel, spring } from './motion.js';

describe('motion tokens', () => {
  it('match DESIGN.md §3', () => {
    expect(spring.snappy).toEqual({ type: 'spring', stiffness: 520, damping: 38, mass: 0.8 });
    expect(spring.smooth).toEqual({ type: 'spring', stiffness: 260, damping: 30 });
    expect(spring.gentle).toEqual({ type: 'spring', stiffness: 120, damping: 20 });
    expect(dur).toEqual({ fast: 0.12, base: 0.22, slow: 0.42 });
    expect(ease).toEqual({ out: [0.16, 1, 0.3, 1], inOut: [0.65, 0, 0.35, 1] });
  });
});

describe('resolveMotionLevel', () => {
  it('follows the OS for "system"', () => {
    expect(resolveMotionLevel('system', false)).toBe('full');
    expect(resolveMotionLevel('system', true)).toBe('reduced');
  });

  it('lets an explicit setting override the OS', () => {
    expect(resolveMotionLevel('full', true)).toBe('full');
    expect(resolveMotionLevel('reduced', false)).toBe('reduced');
    expect(resolveMotionLevel('off', false)).toBe('off');
  });
});

describe('motionConfigFor', () => {
  it('maps levels to Motion settings', () => {
    expect(motionConfigFor('full')).toEqual({ reducedMotion: 'never', skipAnimations: false });
    expect(motionConfigFor('reduced')).toEqual({ reducedMotion: 'always', skipAnimations: false });
    expect(motionConfigFor('off')).toEqual({ reducedMotion: 'always', skipAnimations: true });
  });
});

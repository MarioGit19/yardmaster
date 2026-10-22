import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyInitialMotion,
  dur,
  ease,
  motionConfigFor,
  motionPreference,
  move,
  resolveMotionLevel,
  slide,
  spring,
  tabGlide,
} from './motion.js';

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

describe('applyInitialMotion', () => {
  it('sets data-motion from the stored setting before the app renders', () => {
    const root = { dataset: {} } as HTMLElement;
    motionPreference.set('reduced');
    expect(applyInitialMotion(root)).toBe('reduced');
    expect(root.dataset.motion).toBe('reduced');
    motionPreference.set('off');
    applyInitialMotion(root);
    expect(root.dataset.motion).toBe('off');
    motionPreference.set('system');
  });
});

describe('move and slide', () => {
  it('hold still at Reduced', () => {
    expect(move(false, 'scale(0.9)')).toBe('scale(0.9)');
    expect(move(true, 'scale(0.9)')).toBe('none');
    expect(slide(false, '80%')).toBe('translateY(80%)');
    expect(slide(true, '80%')).toBe('none');
  });
});

describe('tabGlide', () => {
  it('glides for pointer selection and snaps for the keyboard', () => {
    expect(tabGlide(false)).toBe(spring.snappy);
    expect(tabGlide(true)).toEqual({ duration: 0 });
  });
});

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every `transform:` animate target that isn't an inline `style` goes through `move`/`slide`, a
 * name defined from them in the same file, or rests at `'none'`. A target that really must move
 * at Reduced (or never runs there) says why with a `motion-still:` comment on or above its line.
 */
function transformLeaks(file: string, text: string): string[] {
  const lines = text.split('\n');
  const leaks: string[] = [];
  lines.forEach((line, i) => {
    for (const match of line.matchAll(/\btransform:\s*/g)) {
      const before = line.slice(0, match.index);
      if (/\bstyle\b/.test(before) || /motion-still:/.test(`${lines[i - 1] ?? ''}${line}`))
        continue;
      const value = line.slice(match.index + match[0].length);
      if (/^(move|slide)\(/.test(value) || /^'none'/.test(value)) continue;
      const name = /^([A-Za-z_$][\w$]*)\b/.exec(value)?.[1];
      const helper =
        name && new RegExp(`\\b${name}\\s*=\\s*(\\([^)]*\\)\\s*=>\\s*)?(move|slide)\\(`).test(text);
      if (!helper) leaks.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
  return leaks;
}

describe('reduced motion', () => {
  it('routes every transform animate target through the still helper', () => {
    // motion.ts defines the helpers.
    const files = sources(SRC).filter((path) => relative(SRC, path) !== 'motion.ts');
    const leaks = files.flatMap((path) =>
      transformLeaks(relative(SRC, path), readFileSync(path, 'utf8')),
    );
    expect(leaks).toEqual([]);
  });

  it('catches a raw transform string', () => {
    const sample = "<motion.div animate={{ transform: 'translateY(8px)' }} />";
    expect(transformLeaks('sample.tsx', sample)).toHaveLength(1);
    expect(
      transformLeaks('sample.tsx', "animate={{ transform: move(still, 'scale(1)') }}"),
    ).toEqual([]);
    expect(transformLeaks('sample.tsx', "<div style={{ transform: 'scale(2)' }} />")).toEqual([]);
    const second =
      "initial={{ transform: move(still, 'scale(0.9)') }} exit={{ transform: 'scale(0.9)' }}";
    expect(transformLeaks('sample.tsx', second)).toHaveLength(1);
  });
});

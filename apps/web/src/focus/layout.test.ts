import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../prefs.js';
import {
  CENTER_MIN,
  COLUMN_LIMITS,
  DEFAULT_SIZES,
  fitSizes,
  HANDLE_PX,
  loadSizes,
  maxWidth,
  saveSizes,
  snapWidth,
} from './layout.js';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const throwing: KeyValueStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
};

describe('fitSizes', () => {
  it('keeps sizes that fit', () => {
    expect(fitSizes({ left: 300, right: 500 }, 1600)).toEqual({ left: 300, right: 500 });
  });

  it('clamps each column to its limits', () => {
    expect(fitSizes({ left: 10, right: 5000 }, 4000)).toEqual({
      left: COLUMN_LIMITS.left.min,
      right: COLUMN_LIMITS.right.max,
    });
  });

  it('shrinks the right column, then the left, to keep the Claude panel usable', () => {
    const width = 280 + 2 * HANDLE_PX + CENTER_MIN + 330;
    expect(fitSizes({ left: 280, right: 600 }, width)).toEqual({ left: 280, right: 330 });
    const tight = COLUMN_LIMITS.right.min + 2 * HANDLE_PX + CENTER_MIN + 230;
    expect(fitSizes({ left: 400, right: 600 }, tight)).toEqual({
      left: 230,
      right: COLUMN_LIMITS.right.min,
    });
  });

  it('never goes below the minimums, even when nothing fits', () => {
    expect(fitSizes(DEFAULT_SIZES, 300)).toEqual({
      left: COLUMN_LIMITS.left.min,
      right: COLUMN_LIMITS.right.min,
    });
  });

  it('ignores the width before the body is measured', () => {
    expect(fitSizes({ left: 300, right: 500 }, 0)).toEqual({ left: 300, right: 500 });
  });
});

describe('maxWidth', () => {
  it('is the room left beside the other column, within the limits', () => {
    expect(maxWidth('left', 400, 1200)).toBe(1200 - 400 - 2 * HANDLE_PX - CENTER_MIN);
    expect(maxWidth('left', 300, 4000)).toBe(COLUMN_LIMITS.left.max);
    expect(maxWidth('right', 400, 500)).toBe(COLUMN_LIMITS.right.min);
  });
});

describe('snapWidth', () => {
  it('lands on the nearest snap width within the radius', () => {
    expect(snapWidth('left', 262, 420)).toBe(280);
    expect(snapWidth('left', 255, 420)).toBe(240);
    expect(snapWidth('right', 430, 640)).toBe(420);
  });

  it('stays where it was released when no snap width is near', () => {
    expect(snapWidth('left', 310.4, 420)).toBe(310);
  });

  it('skips snap widths beyond the current maximum', () => {
    expect(snapWidth('left', 395, 380)).toBe(380);
  });
});

describe('persistence', () => {
  it('round-trips per project', () => {
    const storage = memoryStorage();
    saveSizes('p-acme', { left: 312.6, right: 500 }, storage);
    expect(loadSizes('p-acme', storage)).toEqual({ left: 313, right: 500 });
    expect(loadSizes('p-zen', storage)).toEqual(DEFAULT_SIZES);
  });

  it('falls back to defaults for corrupt or partial entries', () => {
    const storage = memoryStorage({
      'cboard.focus.a': '{not json',
      'cboard.focus.b': '"280"',
      'cboard.focus.c': JSON.stringify({ left: 'wide', right: 9000 }),
      'cboard.focus.d': JSON.stringify({ left: Number.NaN, right: -4 }),
    });
    expect(loadSizes('a', storage)).toEqual(DEFAULT_SIZES);
    expect(loadSizes('b', storage)).toEqual(DEFAULT_SIZES);
    expect(loadSizes('c', storage)).toEqual({
      left: DEFAULT_SIZES.left,
      right: COLUMN_LIMITS.right.max,
    });
    expect(loadSizes('d', storage)).toEqual(DEFAULT_SIZES);
  });

  it('survives storage that throws', () => {
    expect(loadSizes('p-acme', throwing)).toEqual(DEFAULT_SIZES);
    expect(() => saveSizes('p-acme', DEFAULT_SIZES, throwing)).not.toThrow();
    expect(loadSizes('p-acme', undefined)).toEqual(DEFAULT_SIZES);
  });
});

import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../lanes/throughput.js';
import {
  actorTag,
  asciiSpark,
  bodyLines,
  consoleGrid,
  FRAME_MAX,
  FRAME_MIN,
  fit,
  GAP,
  pickNumber,
  projectTag,
  rowColumns,
  TAG_WIDTH,
} from './console.js';

const ring = (values: Record<number, number>) => ({
  /** `values` by age: 0 is the newest sample. */
  at: (i: number) => values[SAMPLES - 1 - i] ?? 0,
});

describe('consoleGrid', () => {
  it('fits four 42-character frames on a 1440 px overview', () => {
    const grid = consoleGrid(174, 20);
    expect(grid).toEqual({ cols: 4, width: 42 });
    expect(grid.cols * grid.width + (grid.cols - 1) * GAP).toBeLessThanOrEqual(174);
  });

  it('never makes more columns than projects, and caps the frame width', () => {
    expect(consoleGrid(174, 2)).toEqual({ cols: 2, width: 86 });
    expect(consoleGrid(174, 1).width).toBe(FRAME_MAX);
    expect(consoleGrid(174, 0).cols).toBe(1);
  });

  it('stacks one frame per row on a phone, at least 40 characters wide', () => {
    expect(consoleGrid(49, 20, true)).toEqual({ cols: 1, width: 49 });
    expect(consoleGrid(20, 3, true).width).toBe(FRAME_MIN);
    expect(consoleGrid(130, 3, true)).toEqual({ cols: 1, width: 130 });
  });
});

describe('bodyLines', () => {
  it('fits every row of frames on the screen, within bounds', () => {
    // 20 projects in 5 rows on ~50 lines: 7 actor lines, so 5 × (7 + 3) − 1 = 49.
    expect(bodyLines(7, 5, 50)).toBe(7);
    expect(bodyLines(7, 5, 44)).toBe(6);
    expect(bodyLines(12, 1, 200)).toBe(8);
    expect(bodyLines(7, 20, 30)).toBe(3);
  });

  it('is only as tall as the busiest project', () => {
    expect(bodyLines(2, 2, 50)).toBe(2);
    expect(bodyLines(0, 1, 50)).toBe(1);
  });
});

describe('fit', () => {
  it('pads and clips to an exact width', () => {
    expect(fit('acme', 6)).toBe('acme  ');
    expect(fit('acme-shop-storefront', 8)).toBe('acme-sh…');
    expect(fit('a\tb\nc', 5)).toBe('a b c');
    expect(fit('anything', 0)).toBe('');
  });

  it('counts code points, so astral characters take one cell each', () => {
    expect(Array.from(fit('🚀🚀🚀🚀', 3))).toHaveLength(3);
  });
});

describe('tags', () => {
  it('names every status in a fixed-width tag', () => {
    expect(actorTag('waiting')).toBe('[WAIT]');
    expect(actorTag('typing')).toBe('[RUN] ');
    expect(actorTag('error')).toBe('[ERR] ');
    expect(actorTag('sleeping')).toHaveLength(TAG_WIDTH);
    expect(projectTag('err')).toBe('[ERR]');
  });
});

describe('rowColumns', () => {
  it('fills the inner width exactly', () => {
    for (const inner of [36, 38, 45, 60, 92]) {
      const c = rowColumns(inner, 7);
      const used = c.num + 1 + 1 + 1 + c.label + 1 + TAG_WIDTH + 1 + (c.spark ? c.spark + 1 : 0);
      expect(used + c.caption + 1).toBe(inner);
    }
  });

  it('adds a sparkline column only on wide frames and widens the number past 9', () => {
    expect(rowColumns(38, 7).spark).toBe(0);
    expect(rowColumns(60, 7).spark).toBeGreaterThan(0);
    expect(rowColumns(38, 12).num).toBe(4);
  });
});

describe('asciiSpark', () => {
  it('is flat without output and rises toward the newest burst', () => {
    expect(asciiSpark([ring({})], 8)).toBe('▁▁▁▁▁▁▁▁');
    const spark = asciiSpark([ring({ 0: 50_000, 1: 50_000, 12: 2_000 })], 8);
    expect(spark).toHaveLength(8);
    expect(spark.at(-1)).toBe('█');
    // Age 12 lands in the fourth bucket from the end.
    expect(spark[4]).not.toBe('▁');
    expect(spark[0]).toBe('▁');
  });

  it('adds rings together', () => {
    const one = asciiSpark([ring({ 0: 10_000 }), ring({ 20: 10_000 })], 8);
    expect(one.at(-1)).toBe('█');
    expect(one[2]).toBe('█');
  });
});

describe('pickNumber', () => {
  it('points at a target at once and waits when a longer number is possible', () => {
    expect(pickNumber('3', 6)).toEqual({ index: 2, pending: false });
    expect(pickNumber('1', 20)).toEqual({ index: 0, pending: true });
    expect(pickNumber('2', 20)).toEqual({ index: 1, pending: true });
    expect(pickNumber('3', 20)).toEqual({ index: 2, pending: false });
    expect(pickNumber('12', 20)).toEqual({ index: 11, pending: false });
  });

  it('ignores numbers out of range', () => {
    expect(pickNumber('0', 6)).toEqual({ index: null, pending: false });
    expect(pickNumber('25', 20)).toEqual({ index: null, pending: false });
    expect(pickNumber('x', 20)).toEqual({ index: null, pending: false });
  });
});

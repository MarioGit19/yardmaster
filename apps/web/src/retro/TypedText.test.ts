import { describe, expect, it } from 'vitest';
import { dur } from '../motion.js';
import { TYPE_MS_PER_CHAR, typedCount } from './TypedText.js';

describe('typedCount', () => {
  it('types a short caption at a steady pace', () => {
    expect(typedCount(10, 0)).toBe(0);
    expect(typedCount(10, TYPE_MS_PER_CHAR * 4)).toBe(4);
    expect(typedCount(10, TYPE_MS_PER_CHAR * 10)).toBe(10);
  });

  it('never takes longer than dur.slow, however long the caption', () => {
    expect(typedCount(200, dur.slow * 500)).toBe(100);
    expect(typedCount(200, dur.slow * 1000)).toBe(200);
    expect(typedCount(0, 0)).toBe(0);
  });
});

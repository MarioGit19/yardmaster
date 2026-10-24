import { describe, expect, it } from 'vitest';
import { pageAt } from './SwipePager.js';

describe('pageAt', () => {
  it('rests on the nearest page', () => {
    expect(pageAt(0, 374, 6)).toBe(0);
    expect(pageAt(200, 374, 6)).toBe(1);
    expect(pageAt(374 * 3, 374, 6)).toBe(3);
  });

  it('stays inside the pages', () => {
    expect(pageAt(9_999, 374, 6)).toBe(5);
    expect(pageAt(-40, 374, 6)).toBe(0);
    expect(pageAt(100, 0, 6)).toBe(0);
    expect(pageAt(100, 374, 0)).toBe(0);
  });
});

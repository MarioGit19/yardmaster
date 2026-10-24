import { describe, expect, it } from 'vitest';
import { pageAt, stableOrder } from './SwipePager.js';

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

describe('stableOrder', () => {
  it('keeps pages in place when the list re-sorts', () => {
    expect(stableOrder(['a', 'b', 'c', 'd'], ['a', 'd', 'c', 'b'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts from the incoming order', () => {
    expect(stableOrder([], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('drops pages that left', () => {
    expect(stableOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
  });

  it('puts a new page after the one it follows, or first', () => {
    expect(stableOrder(['a', 'b', 'c'], ['a', 'c', 'x', 'b'])).toEqual(['a', 'b', 'c', 'x']);
    expect(stableOrder(['a', 'b'], ['y', 'b', 'a'])).toEqual(['y', 'a', 'b']);
    expect(stableOrder(['a'], ['a', 'x', 'z'])).toEqual(['a', 'x', 'z']);
  });
});

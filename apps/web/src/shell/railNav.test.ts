import { describe, expect, it } from 'vitest';
import { isTypingTarget, railKeyTarget } from './railNav.js';

describe('railKeyTarget', () => {
  it('moves down and up with wrap-around', () => {
    expect(railKeyTarget('ArrowDown', 0, 3)).toBe(1);
    expect(railKeyTarget('ArrowDown', 2, 3)).toBe(0);
    expect(railKeyTarget('ArrowUp', 0, 3)).toBe(2);
    expect(railKeyTarget('k', 2, 3)).toBe(1);
    expect(railKeyTarget('j', 1, 3)).toBe(2);
  });

  it('enters from outside the list at the nearest end', () => {
    expect(railKeyTarget('ArrowDown', -1, 3)).toBe(0);
    expect(railKeyTarget('ArrowUp', -1, 3)).toBe(2);
  });

  it('jumps with Home and End', () => {
    expect(railKeyTarget('Home', 2, 4)).toBe(0);
    expect(railKeyTarget('End', 0, 4)).toBe(3);
  });

  it('ignores other keys and empty lists', () => {
    expect(railKeyTarget('Enter', 0, 3)).toBeNull();
    expect(railKeyTarget('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('spots text fields only', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(
      isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isTypingTarget({ tagName: 'A', isContentEditable: false } as unknown as EventTarget),
    ).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

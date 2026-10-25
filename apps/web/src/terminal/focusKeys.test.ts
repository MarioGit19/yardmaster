import { describe, expect, it } from 'vitest';
import { releasesFocus } from './focusKeys.js';

const key = (
  key: string,
  mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {},
) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('releasesFocus', () => {
  it('lets Tab and Shift+Tab move on from a read-only mirror', () => {
    expect(releasesFocus(key('Tab'), false)).toBe(true);
    expect(releasesFocus(key('Tab', { shiftKey: true }), false)).toBe(true);
  });

  it('keeps Tab for the shell in a board terminal, and Shift+Tab leaves', () => {
    expect(releasesFocus(key('Tab'), true)).toBe(false);
    expect(releasesFocus(key('Tab', { shiftKey: true }), true)).toBe(true);
  });

  it('leaves every other key to the program', () => {
    expect(releasesFocus(key('Escape'), true)).toBe(false);
    expect(releasesFocus(key('a'), false)).toBe(false);
    expect(releasesFocus(key('Tab', { ctrlKey: true }), false)).toBe(false);
  });
});

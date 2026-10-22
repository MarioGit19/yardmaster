import { describe, expect, it } from 'vitest';
import { applyTheme, resolveTheme } from './theme.js';

describe('resolveTheme', () => {
  it('defaults to explicit settings and follows the OS for "system"', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('sets data-theme only for light', () => {
    const root = { dataset: {} as DOMStringMap } as HTMLElement;
    applyTheme(root, 'light');
    expect(root.dataset.theme).toBe('light');
    applyTheme(root, 'dark');
    expect(root.dataset.theme).toBeUndefined();
  });
});

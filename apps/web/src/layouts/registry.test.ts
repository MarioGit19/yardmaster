import { describe, expect, it } from 'vitest';
import { createPreference } from '../prefs.js';
import { LAYOUTS, layoutShortcut } from './registry.js';

const key = (
  code: string,
  mods: Partial<Record<'alt' | 'meta' | 'ctrl' | 'shift', boolean>> = {},
) => ({
  code,
  altKey: mods.alt ?? true,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
});

describe('layoutShortcut', () => {
  it('maps ⌥1…⌥5 to the layouts in order, by physical key', () => {
    expect(['1', '2', '3', '4', '5'].map((n) => layoutShortcut(key(`Digit${n}`)))).toEqual([
      ...LAYOUTS,
    ]);
  });

  it('ignores other digits, plain digits and other modifiers', () => {
    expect(layoutShortcut(key('Digit6'))).toBeNull();
    expect(layoutShortcut(key('Digit1', { alt: false }))).toBeNull();
    expect(layoutShortcut(key('Digit1', { meta: true }))).toBeNull();
    expect(layoutShortcut(key('Digit1', { shift: true }))).toBeNull();
    expect(layoutShortcut(key('KeyA'))).toBeNull();
  });
});

describe('the layout preference', () => {
  it('persists a choice and falls back to Minimal for unknown values', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    createPreference('cboard.layout', LAYOUTS, 'minimal', storage).set('grid');
    expect(store.get('cboard.layout')).toBe('grid');
    expect(createPreference('cboard.layout', LAYOUTS, 'minimal', storage).get()).toBe('grid');
    store.set('cboard.layout', 'holodeck');
    expect(createPreference('cboard.layout', LAYOUTS, 'minimal', storage).get()).toBe('minimal');
  });
});

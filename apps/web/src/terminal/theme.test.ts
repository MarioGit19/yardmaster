import { describe, expect, it } from 'vitest';
import { xtermTheme } from './theme.js';

describe('xtermTheme', () => {
  it('takes every color from the tokens', () => {
    const theme = xtermTheme((expression) => `resolved(${expression})`);
    expect(theme.background).toBe('resolved(var(--bg-0))');
    expect(theme.foreground).toBe('resolved(var(--text-1))');
    expect(theme.red).toBe('resolved(var(--st-err))');
    expect(theme.green).toBe('resolved(var(--st-ok))');
    expect(theme.brightRed).toBe('resolved(color-mix(in srgb, var(--st-err) 80%, var(--text-1)))');
    expect(theme.brightBlack).toBe('resolved(var(--text-2))');
    for (const value of Object.values(theme)) expect(value).toMatch(/^resolved\(/);
  });
});

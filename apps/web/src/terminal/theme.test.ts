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

describe('xtermTheme for a workspace skin', () => {
  it('draws Retro in phosphor from the skin tokens', () => {
    const theme = xtermTheme((expression) => `resolved(${expression})`, 'retro');
    expect(theme.background).toBe('resolved(var(--retro-bg))');
    expect(theme.foreground).toBe('resolved(var(--retro-ink))');
    expect(theme.red).toBe('resolved(var(--retro-tone-err))');
    expect(theme.brightBlack).toBe('resolved(var(--retro-dim-ink))');
    expect(theme.brightRed).toBe(
      'resolved(color-mix(in srgb, var(--retro-tone-err) 80%, var(--retro-ink)))',
    );
  });

  it('leaves Minimal as the default', () => {
    const resolve = (expression: string) => expression;
    expect(xtermTheme(resolve, 'minimal')).toEqual(xtermTheme(resolve));
  });
});

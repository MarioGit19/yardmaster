import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { phosphorToken } from '../fx/FaultyTerminal.js';
import { createPreference } from '../prefs.js';
import { PHOSPHOR_LABEL, PHOSPHORS } from './phosphor.js';

const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const [darkBlock = '', lightBlock = ''] = tokens.split(/\[data-theme=['"]light['"]\]/);
const index = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8');

function token(block: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`).exec(block)?.[1];
  if (!value) throw new Error(`--${name} is not a hex token`);
  return value;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('the Retro phosphor setting', () => {
  it('offers green, amber, red, purple, cyan and white, each with a label', () => {
    expect([...PHOSPHORS]).toEqual(['green', 'amber', 'red', 'purple', 'cyan', 'white']);
    for (const phosphor of PHOSPHORS) expect(PHOSPHOR_LABEL[phosphor]).toMatch(/^[A-Z]/);
  });

  it('persists a color per browser and falls back to green', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    createPreference('yardmaster.phosphor', PHOSPHORS, 'green', storage).set('purple');
    expect(store.get('yardmaster.phosphor')).toBe('purple');
    expect(createPreference('yardmaster.phosphor', PHOSPHORS, 'green', storage).get()).toBe(
      'purple',
    );
    store.set('yardmaster.phosphor', 'magenta');
    expect(createPreference('yardmaster.phosphor', PHOSPHORS, 'green', storage).get()).toBe(
      'green',
    );
  });

  it('gives every phosphor a text, dim and bright ink at AA in Night and Daylight', () => {
    for (const block of [darkBlock, lightBlock]) {
      const bg = token(block, 'retro-bg');
      for (const phosphor of PHOSPHORS) {
        const name = phosphorToken(phosphor);
        const ink = contrast(token(block, name), bg);
        const dim = contrast(token(block, `${name}-dim`), bg);
        const bright = contrast(token(block, `${name}-bright`), bg);
        expect(dim, `${name}-dim`).toBeGreaterThanOrEqual(6.5);
        expect(ink, name).toBeGreaterThan(dim);
        expect(bright, `${name}-bright`).toBeGreaterThan(ink);
      }
    }
  });

  it('switches the whole family on the console, its ground and the workspace', () => {
    for (const phosphor of PHOSPHORS.filter((p) => p !== 'green')) {
      const rule = new RegExp(
        `\\[data-phosphor="${phosphor}"\\] \\{\\s*--retro-ink: var\\(--retro-${phosphor}\\);\\s*--retro-dim-ink: var\\(--retro-${phosphor}-dim\\);\\s*--retro-bright-ink: var\\(--retro-${phosphor}-bright\\);`,
      );
      expect(index, phosphor).toMatch(rule);
      expect(index).toContain(`.fx-terminal-fallback[data-phosphor="${phosphor}"]`);
    }
  });
});

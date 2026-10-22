import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCENT_HUES, accentIndex, accentVar } from './accents.js';

const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const [darkBlock = '', lightBlock = ''] = css.split(/\[data-theme=['"]light['"]\]/);

function token(block: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

/** sRGB hex → OKLCH hue in degrees. */
function hue(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(n >> 16), lin((n >> 8) & 255), lin(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

const DARK = {
  'bg-0': '#05060a',
  'bg-1': '#0a0c12',
  'bg-2': '#10131b',
  glass: 'rgb(255 255 255 / 0.03)',
  line: 'rgb(255 255 255 / 0.07)',
  'line-strong': 'rgb(255 255 255 / 0.14)',
  'text-1': '#edeff5',
  'text-2': '#a3a9b8',
  'text-3': '#6b7183',
  'st-work': '#7c9cff',
  'st-tool': '#5ee7ff',
  'st-wait': '#ffb547',
  'st-ok': '#3ddc97',
  'st-err': '#ff5c7a',
  'st-idle': '#6b7183',
};

const STATUS = ['work', 'tool', 'wait', 'ok', 'err', 'idle'];

describe('tokens.css', () => {
  it('defines the dark palette from DESIGN.md §2', () => {
    for (const [name, value] of Object.entries(DARK)) expect(token(darkBlock, name)).toBe(value);
  });

  it('defines a 35% glow for every status', () => {
    for (const st of STATUS) {
      expect(token(darkBlock, `st-${st}-glow`)).toBe(
        `color-mix(in srgb, var(--st-${st}) 35%, transparent)`,
      );
    }
  });

  it('defines the light palette, overriding surfaces, text and every status', () => {
    expect(token(lightBlock, 'bg-0')).toBe('#f7f7f4');
    expect(token(lightBlock, 'bg-1')).toBe('#ffffff');
    expect(token(lightBlock, 'line')).toBe('rgb(0 0 0 / 0.08)');
    expect(token(lightBlock, 'text-1')).toBe('#0e1116');
    expect(token(lightBlock, 'glass')).toBe('rgb(255 255 255 / 0.7)');
    for (const st of STATUS) {
      const light = token(lightBlock, `st-${st}`);
      expect(light).toMatch(/^#[0-9a-f]{6}$/);
      expect(light).not.toBe(token(darkBlock, `st-${st}`));
    }
  });

  it('defines one accent variable per accent hue', () => {
    ACCENT_HUES.forEach((h, i) => {
      expect(token(darkBlock, `accent-${i}`)).toBe(`oklch(0.72 0.14 ${h})`);
    });
  });
});

describe('project accents', () => {
  it('keep every hue at least 15° from the chromatic status hues', () => {
    const statusHues = ['work', 'tool', 'wait', 'ok', 'err'].map((st) =>
      hue(token(darkBlock, `st-${st}`) ?? ''),
    );
    for (const accent of ACCENT_HUES) {
      for (const status of statusHues) {
        const diff = Math.abs(accent - status) % 360;
        expect(Math.min(diff, 360 - diff)).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('assigns a stable accent per path and spreads paths across the palette', () => {
    expect(accentIndex('/home/dev/acme-shop')).toBe(accentIndex('/home/dev/acme-shop'));
    expect(accentVar('/home/dev/acme-shop')).toMatch(/^var\(--accent-\d\)$/);
    const used = new Set(
      Array.from({ length: 200 }, (_, i) => accentIndex(`/home/dev/project-${i}`)),
    );
    expect(used.size).toBe(ACCENT_HUES.length);
  });
});

import { describe, expect, it } from 'vitest';
import { ACCENT_COUNT } from './domain.js';
import {
  ACCENT_HUES,
  accentForProject,
  accentIndexForProject,
  projectIdFromPath,
} from './project.js';

const STATUS_HEX = ['#7C9CFF', '#5EE7FF', '#FFB547', '#3DDC97', '#FF5C7A'];

function oklchHue(hex: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(hex.slice(i, i + 2), 16))) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

// The package lib has no DOM or Node types, but the test runtime has TextEncoder.
const { TextEncoder } = globalThis as unknown as {
  TextEncoder: new () => { encode(input: string): Uint8Array };
};

const hueDistance = (x: number, y: number) => {
  const d = Math.abs(x - y) % 360;
  return Math.min(d, 360 - d);
};

describe('projectIdFromPath', () => {
  it('is a 12-char hex string', () => {
    expect(projectIdFromPath('/home/dev/acme-shop')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable across calls and releases', () => {
    // Pinned values: changing the hash would orphan every stored project.
    expect(projectIdFromPath('/home/dev/acme-shop')).toBe(projectIdFromPath('/home/dev/acme-shop'));
    expect(projectIdFromPath('/home/dev/acme-shop')).toMatchInlineSnapshot(`"928c1e3fb5f1"`);
    expect(projectIdFromPath('/')).toMatchInlineSnapshot(`"af63a24c8601"`);
  });

  it('hashes UTF-8 bytes like TextEncoder', () => {
    const byHand = (path: string) => {
      let hash = 0xcbf29ce484222325n;
      for (const byte of new TextEncoder().encode(path.replace(/\/+$/, '') || '/')) {
        hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return hash.toString(16).padStart(16, '0').slice(0, 12);
    };
    for (const path of [
      '/home/dev/café',
      '/home/dev/プロジェクト',
      '/home/dev/🚀-app',
      '/x/\ud800',
    ]) {
      expect(projectIdFromPath(path)).toBe(byHand(path));
    }
  });

  it('ignores trailing slashes', () => {
    expect(projectIdFromPath('/home/dev/acme-shop/')).toBe(
      projectIdFromPath('/home/dev/acme-shop'),
    );
    expect(projectIdFromPath('///')).toBe(projectIdFromPath('/'));
  });

  it('distinguishes different paths, including case and unicode', () => {
    const paths = [
      '/home/dev/acme-shop',
      '/home/dev/Acme-Shop',
      '/home/dev/acme-shop-api',
      '/home/dev/café',
      '/home/dev/cafe',
      '/srv/projects/globex',
    ];
    expect(new Set(paths.map(projectIdFromPath)).size).toBe(paths.length);
  });

  it('has no collisions across many synthetic paths', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(projectIdFromPath(`/home/dev/project-${i}`));
    expect(ids.size).toBe(10_000);
  });
});

describe('accentForProject', () => {
  it('defines exactly ACCENT_COUNT distinct hues', () => {
    expect(ACCENT_HUES).toHaveLength(ACCENT_COUNT);
    expect(new Set(ACCENT_HUES).size).toBe(ACCENT_COUNT);
  });

  it('keeps every accent more than 15° away from the status hues', () => {
    for (const hue of ACCENT_HUES) {
      for (const hex of STATUS_HEX) {
        expect(hueDistance(hue, oklchHue(hex)), `${hue} vs ${hex}`).toBeGreaterThan(15);
      }
    }
  });

  it('is stable and returns a valid OKLCH color', () => {
    const id = projectIdFromPath('/home/dev/acme-shop');
    const accent = accentForProject(id);
    expect(accentForProject(id)).toEqual(accent);
    expect(accent.index).toBe(accentIndexForProject(id));
    expect(accent.hue).toBe(ACCENT_HUES[accent.index]);
    expect(accent.css).toBe(`oklch(0.72 0.14 ${accent.hue})`);
  });

  it('spreads projects across all hues', () => {
    const counts = new Array<number>(ACCENT_COUNT).fill(0);
    for (let i = 0; i < 1000; i++) {
      const { index } = accentForProject(projectIdFromPath(`/home/dev/project-${i}`));
      counts[index] = (counts[index] ?? 0) + 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(50);
  });
});

import { describe, expect, it } from 'vitest';
import { fuzzyMatch, highlightRuns } from './fuzzy.js';

const hits = (query: string, text: string) => {
  const match = fuzzyMatch(query, text);
  return match ? match.indices.map((i) => text[i]).join('') : null;
};

describe('fuzzyMatch', () => {
  it('matches characters in order, case-insensitively', () => {
    expect(hits('ACM', 'acme-shop')).toBe('acm');
    expect(hits('ashp', 'acme-shop')).toBe('ashp');
    expect(fuzzyMatch('pohs', 'acme-shop')).toBeNull();
  });

  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('  ', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('prefers word starts and runs over scattered letters', () => {
    // "sh" should land on "shop", not the s in "acme-s…" scattered with an h.
    expect(fuzzyMatch('sh', 'acme-shop')?.indices).toEqual([5, 6]);
    expect(fuzzyMatch('rl', 'Rate limiter')?.indices).toEqual([0, 5]);
    expect(fuzzyMatch('cart', 'src/cart.ts')?.indices).toEqual([4, 5, 6, 7]);
  });

  it('ranks a prefix above a mid-word match', () => {
    const prefix = fuzzyMatch('orb', 'orbit-api')?.score ?? 0;
    const inner = fuzzyMatch('orb', 'neworbit')?.score ?? 0;
    expect(prefix).toBeGreaterThan(inner);
  });

  it('ranks a contiguous match above a scattered one', () => {
    const run = fuzzyMatch('term', 'Terminals')?.score ?? 0;
    const scattered = fuzzyMatch('term', 'The emerald room')?.score ?? 0;
    expect(run).toBeGreaterThan(scattered);
  });

  it('treats camelCase humps as word starts', () => {
    expect(fuzzyMatch('ms', 'multiStep')?.indices).toEqual([0, 5]);
  });

  it('needs every word of a multi-word query', () => {
    expect(hits('new acme', 'New session in acme-shop')).toBe('Newacme');
    expect(fuzzyMatch('new orbit', 'New session in acme-shop')).toBeNull();
  });

  it('keeps indices aligned with text whose lowercase changes length', () => {
    const text = 'İstanbul shop';
    expect(fuzzyMatch('shop', text)?.indices).toEqual([9, 10, 11, 12]);
  });

  it('drops scattered mid-word letters as noise', () => {
    expect(fuzzyMatch('re', 'Toggle the project rail')).toBeNull();
    expect(fuzzyMatch('e', 'acme-shop')).toBeNull();
    expect(fuzzyMatch('s', 'acme-shop')?.indices).toEqual([5]);
    expect(fuzzyMatch('re', 'Re-run last command')?.indices).toEqual([0, 1]);
  });

  it('copes with a query longer than the text', () => {
    expect(fuzzyMatch('abcdef', 'abc')).toBeNull();
  });
});

describe('highlightRuns', () => {
  it('groups consecutive hits', () => {
    expect(highlightRuns('acme-shop', [0, 1, 5])).toEqual([
      { text: 'ac', hit: true },
      { text: 'me-', hit: false },
      { text: 's', hit: true },
      { text: 'hop', hit: false },
    ]);
  });

  it('returns one plain run without hits', () => {
    expect(highlightRuns('zsh', [])).toEqual([{ text: 'zsh', hit: false }]);
  });
});

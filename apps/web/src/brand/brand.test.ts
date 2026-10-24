// @vitest-environment happy-dom
import { emptyBoardState } from '@yardmaster/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSession, makeTerminal, sampleBoard } from '../test/board.js';
import { applyFavicon, documentTitle, faviconHref, faviconState, waitingCount } from './favicon.js';
import logoSource from './logo.svg?raw';
import { LOGO_SOURCE_ACCENT, parseLogo, renderLogo, svgDataUrl } from './render.js';

describe('renderLogo', () => {
  it('recolors the Y and the orb', () => {
    const svg = renderLogo(logoSource, { ink: '#111111', accent: '#222222' });
    expect(svg).not.toContain('currentColor');
    expect(svg).not.toContain(LOGO_SOURCE_ACCENT);
    expect(svg.match(/fill:#111111/g)).toHaveLength(3);
    expect(svg.match(/fill:#222222/g)).toHaveLength(1);
  });

  it('accepts CSS variables for inline use', () => {
    const svg = renderLogo(logoSource, { ink: 'currentColor', accent: 'var(--st-work)' });
    expect(svg).toContain('fill:var(--st-work)');
    expect(svg).toContain('fill:currentColor');
  });

  it('stays one flat drawing: no text, rasters, gradients or filters', () => {
    expect(logoSource).not.toMatch(/<(text|image|filter|mask|linearGradient|radialGradient)\b/);
  });

  it('adds a badge dot only when asked', () => {
    expect(renderLogo(logoSource, { ink: 'red', accent: 'blue' })).not.toContain('cx="212"');
    const svg = renderLogo(logoSource, { ink: 'red', accent: 'blue', badge: 'orange' });
    expect(svg).toMatch(/<circle cx="212"[^>]*fill:orange[^>]*\/>\s*<\/svg>$/);
  });

  it('stays parseable SVG', () => {
    const svg = renderLogo(logoSource, { ink: 'red', accent: 'blue', badge: 'orange' });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.tagName).toBe('svg');
  });

  it('splits into the three strokes and the orb', () => {
    const parts = parseLogo(logoSource);
    expect(parts.viewBox).toBe('0 0 256 256');
    expect(parts.strokes).toHaveLength(3);
    for (const d of parts.strokes) expect(d).toMatch(/^M[\d.]+ [\d.]+L.*Z$/);
    expect(parts.orb).toEqual({ cx: 128, cy: 114, r: 30 });
  });

  it('builds an encoded data URL', () => {
    expect(svgDataUrl('<svg a="#1"/>')).toBe('data:image/svg+xml,%3Csvg%20a%3D%22%231%22%2F%3E');
  });
});

describe('favicon state', () => {
  it('is idle for an empty board', () => {
    const board = emptyBoardState();
    expect(faviconState(board)).toBe('idle');
    expect(waitingCount(board)).toBe(0);
  });

  it('prefers waiting over errors and counts waiting sessions', () => {
    const board = sampleBoard();
    board.sessions['s-3'] = makeSession('s-3', 'p-zen', { kind: 'waiting_input' });
    expect(faviconState(board)).toBe('wait');
    expect(waitingCount(board)).toBe(2);
  });

  it('turns to error for a crashed session or terminal', () => {
    const board = emptyBoardState();
    board.sessions.s = makeSession('s', 'p', { kind: 'error', message: 'boom' });
    expect(faviconState(board)).toBe('err');

    const terminalOnly = emptyBoardState();
    terminalOnly.terminals.t = makeTerminal('t', 'p', 137);
    expect(faviconState(terminalOnly)).toBe('err');
  });

  it('stays idle while work is just running', () => {
    const board = emptyBoardState();
    board.sessions.s = makeSession('s', 'p', { kind: 'working' });
    board.terminals.t = makeTerminal('t', 'p', 0);
    expect(faviconState(board)).toBe('idle');
  });

  it('gives each state its own icon', () => {
    const hrefs = new Set((['idle', 'wait', 'err'] as const).map(faviconHref));
    expect(hrefs.size).toBe(3);
  });

  it('puts the waiting count in the title', () => {
    expect(documentTitle(0)).toBe('Yardmaster');
    expect(documentTitle(2)).toBe('(2) Yardmaster');
  });
});

describe('applyFavicon', () => {
  afterEach(() => document.querySelector('#live-favicon')?.remove());

  it('creates one SVG icon link and updates it in place', () => {
    applyFavicon(document, 'idle', 0);
    const link = document.querySelector<HTMLLinkElement>('link#live-favicon');
    expect(link?.rel).toBe('icon');
    expect(link?.type).toBe('image/svg+xml');
    expect(link?.dataset.state).toBe('idle');
    expect(document.title).toBe('Yardmaster');
    const idleHref = link?.href;

    applyFavicon(document, 'wait', 3);
    expect(document.querySelectorAll('link#live-favicon')).toHaveLength(1);
    expect(link?.dataset.state).toBe('wait');
    expect(link?.href).not.toBe(idleHref);
    expect(document.title).toBe('(3) Yardmaster');
  });
});

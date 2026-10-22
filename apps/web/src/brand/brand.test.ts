// @vitest-environment happy-dom
import { emptyBoardState } from '@c-board/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSession, makeTerminal, sampleBoard } from '../test/board.js';
import { applyFavicon, documentTitle, faviconHref, faviconState, waitingCount } from './favicon.js';
import logoSource from './logo.svg?raw';
import { LOGO_SOURCE_ACCENT, renderLogo, svgDataUrl } from './render.js';

describe('renderLogo', () => {
  it('recolors the ring and every accent use', () => {
    const svg = renderLogo(logoSource, { ring: '#111111', accent: '#222222' });
    expect(svg).not.toContain('currentColor');
    expect(svg).not.toContain(LOGO_SOURCE_ACCENT);
    expect(svg).toContain('stroke:#111111');
    expect(svg).toContain('fill:#222222');
    expect(svg).toContain('stop-color:#222222');
  });

  it('accepts CSS variables for inline use', () => {
    const svg = renderLogo(logoSource, { ring: 'currentColor', accent: 'var(--st-work)' });
    expect(svg).toContain('fill:var(--st-work)');
  });

  it('suffixes gradient ids so several marks can share a page', () => {
    const svg = renderLogo(logoSource, { ring: 'red', accent: 'blue' }, 'r1');
    expect(svg).toContain('id="cb-glow-r1"');
    expect(svg).toContain('url(#cb-glow-r1)');
  });

  it('adds a badge dot only when asked', () => {
    expect(renderLogo(logoSource, { ring: 'red', accent: 'blue' })).not.toContain('cx="19.5"');
    const svg = renderLogo(logoSource, { ring: 'red', accent: 'blue', badge: 'orange' });
    expect(svg).toMatch(/<circle cx="19\.5"[^>]*fill:orange[^>]*\/>\s*<\/svg>$/);
  });

  it('stays parseable SVG', () => {
    const svg = renderLogo(logoSource, { ring: 'red', accent: 'blue', badge: 'orange' }, 'x');
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.tagName).toBe('svg');
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
    expect(documentTitle(0)).toBe('c-board');
    expect(documentTitle(2)).toBe('(2) c-board');
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
    expect(document.title).toBe('c-board');
    const idleHref = link?.href;

    applyFavicon(document, 'wait', 3);
    expect(document.querySelectorAll('link#live-favicon')).toHaveLength(1);
    expect(link?.dataset.state).toBe('wait');
    expect(link?.href).not.toBe(idleHref);
    expect(document.title).toBe('(3) c-board');
  });
});

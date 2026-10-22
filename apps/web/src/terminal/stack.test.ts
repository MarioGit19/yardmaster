import { describe, expect, it } from 'vitest';
import {
  actionErrorText,
  GRID_MAX,
  gridTerminals,
  MAX_CLOSED_TABS,
  paneKind,
  resolveActive,
  stackOrder,
  stepTab,
} from './stack.js';

const T0 = 1_760_000_000_000;

const term = (
  id: string,
  createdAt: number,
  extra: Partial<{ state: 'open' | 'closed'; closedAt: number | null; active: boolean }> = {},
) => ({ id, createdAt, state: 'open' as const, closedAt: null, active: false, ...extra });

describe('stackOrder', () => {
  it('lists open terminals by creation, then the most recently closed ones', () => {
    const ordered = stackOrder([
      term('b', T0 + 2),
      term('old', T0, { state: 'closed', closedAt: T0 + 5 }),
      term('a', T0 + 1),
      term('new', T0, { state: 'closed', closedAt: T0 + 9 }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(['a', 'b', 'new', 'old']);
  });

  it(`keeps at most ${MAX_CLOSED_TABS} closed terminals`, () => {
    const closed = Array.from({ length: 6 }, (_, i) =>
      term(`c${i}`, T0, { state: 'closed', closedAt: T0 + i }),
    );
    expect(stackOrder(closed).map((t) => t.id)).toEqual(['c5', 'c4', 'c3', 'c2']);
  });
});

describe('resolveActive', () => {
  const ordered = [term('a', T0), term('b', T0 + 1, { active: true }), term('c', T0 + 2)];

  it('keeps the chosen tab while it exists', () => {
    expect(resolveActive(ordered, 'c')).toBe('c');
  });

  it("falls back to the editor's active terminal, then the first", () => {
    expect(resolveActive(ordered, 'gone')).toBe('b');
    expect(resolveActive([term('a', T0), term('c', T0)], null)).toBe('a');
    expect(resolveActive([], null)).toBeNull();
  });

  it('prefers a terminal it can mirror when nothing was chosen', () => {
    const interactive = new Set(['b']);
    const mirrorable = (id: string) => !interactive.has(id);
    expect(resolveActive(ordered, null, mirrorable)).toBe('a');
    expect(resolveActive(ordered, 'b', mirrorable)).toBe('b');
    interactive.add('a');
    expect(resolveActive(ordered, null, mirrorable)).toBe('c');
    interactive.add('c');
    expect(resolveActive(ordered, null, mirrorable)).toBe('b');
  });
});

describe('gridTerminals', () => {
  const ordered = Array.from({ length: 6 }, (_, i) => term(`t${i}`, T0 + i));

  it('shows the first four, swapping in the active one when it is further down', () => {
    expect(gridTerminals(ordered, 't1').map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3']);
    expect(gridTerminals(ordered, 't5').map((t) => t.id)).toEqual(['t0', 't1', 't2', 't5']);
    expect(gridTerminals(ordered, null)).toHaveLength(GRID_MAX);
    expect(gridTerminals(ordered.slice(0, 2), 't1')).toHaveLength(2);
  });
});

describe('paneKind', () => {
  const open = { state: 'open' as const };

  it('points a running alt-screen app to the editor', () => {
    expect(paneKind({ interactive: true, endedAt: null }, open)).toBe('interactive');
  });

  it('mirrors everything else, including a finished interactive run', () => {
    expect(paneKind({ interactive: true, endedAt: T0 }, open)).toBe('xterm');
    expect(paneKind({ interactive: true, endedAt: null }, { state: 'closed' })).toBe('xterm');
    expect(paneKind({ interactive: false, endedAt: null }, open)).toBe('xterm');
    expect(paneKind(null, open)).toBe('xterm');
  });
});

describe('stepTab', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('wraps around both ways', () => {
    expect(stepTab(tabs, 'c', 1)).toBe('a');
    expect(stepTab(tabs, 'a', -1)).toBe('c');
    expect(stepTab(tabs, 'missing', 1)).toBe('a');
    expect(stepTab([], 'a', 1)).toBeNull();
  });
});

describe('actionErrorText', () => {
  it('explains known server codes and has a fallback', () => {
    expect(actionErrorText('editor_offline')).toBe('The editor window is offline');
    expect(actionErrorText('weird')).toBe('The terminal command failed');
  });
});

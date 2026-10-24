import { type BoardState, emptyBoardState } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { makeSession, makeTerminal } from '../../test/board.js';
import {
  hubFailures,
  hubItems,
  hubItemsKey,
  itemHref,
  neighbour,
  otherNeedsYou,
  parseHubItems,
  routeItem,
  sessionGroup,
} from './model.js';

const T0 = 1_760_000_000_000;

function board(): BoardState {
  const b = emptyBoardState();
  const waiting = makeSession('s-wait', 'p-acme', { kind: 'waiting_input' }, 'Ask about tests');
  const working = makeSession('s-work', 'p-acme', { kind: 'working' }, 'Refactor cart');
  const linked = {
    ...makeSession('s-term', 'p-acme', { kind: 'idle' }, 'In a terminal'),
    terminalId: 't-claude',
  };
  const ended = { ...makeSession('s-old', 'p-acme', { kind: 'ended' }), startedAt: T0 - 1 };
  const other = makeSession('s-other', 'p-orbit', { kind: 'working' });
  for (const s of [waiting, working, linked, ended, other]) b.sessions[s.id] = s;
  const dev = { ...makeTerminal('t-dev', 'p-acme'), executionIds: ['e-dev'] };
  b.terminals['t-dev'] = dev;
  b.terminals['t-claude'] = { ...makeTerminal('t-claude', 'p-acme'), createdAt: T0 + 1 };
  b.terminals['t-idle'] = { ...makeTerminal('t-idle', 'p-acme'), createdAt: T0 + 2 };
  b.executions['e-dev'] = {
    id: 'e-dev',
    terminalId: 't-dev',
    commandLine: 'pnpm dev',
    confidence: 'high',
    cwd: null,
    startedAt: T0,
    endedAt: null,
    exitCode: null,
    outputBytes: 0,
    truncated: false,
    interactive: false,
  };
  return b;
}

describe('hubFailures', () => {
  it('counts sessions in error and terminals whose last command failed', () => {
    const b = board();
    expect(hubFailures(b, hubItems(b, 'p-acme'))).toBe(0);
    b.sessions['s-work'] = makeSession('s-work', 'p-acme', { kind: 'error', message: 'boom' });
    const dev = b.executions['e-dev'];
    if (dev) b.executions['e-dev'] = { ...dev, endedAt: T0 + 5, exitCode: 1 };
    // A terminal closed with exit 0 is not a failure.
    b.terminals['t-idle'] = { ...makeTerminal('t-idle', 'p-acme'), state: 'closed', exitCode: 0 };
    expect(hubFailures(b, hubItems(b, 'p-acme'))).toBe(2);
  });
});

describe('hubItems', () => {
  it('groups everything Needs you, Running, Idle, with a Claude terminal as one card', () => {
    const items = hubItems(board(), 'p-acme');
    expect(items.map((i) => [i.key, i.group])).toEqual([
      ['s:s-wait', 'needs'],
      ['s:s-work', 'running'],
      ['t:t-dev', 'running'],
      ['s:s-term', 'idle'],
      ['s:s-old', 'idle'],
      ['t:t-idle', 'idle'],
    ]);
    // The terminal running `s-term` is folded into its card, not listed again.
    expect(items.find((i) => i.key === 's:s-term')).toMatchObject({ terminalId: 't-claude' });
    expect(items.some((i) => i.key === 't:t-claude')).toBe(false);
  });

  it('reads waits, work and the rest into groups', () => {
    expect(sessionGroup({ kind: 'waiting_permission', approvalId: 'a-1' })).toBe('needs');
    expect(sessionGroup({ kind: 'tool', tool: 'Bash', toolUseId: 'tu-1' })).toBe('running');
    expect(sessionGroup({ kind: 'unknown', alive: true })).toBe('running');
    expect(sessionGroup({ kind: 'error', message: null })).toBe('idle');
  });

  it('survives a round trip through its selector key', () => {
    const items = hubItems(board(), 'p-acme');
    expect(parseHubItems(hubItemsKey(items))).toEqual(items);
    expect(parseHubItems('')).toEqual([]);
  });
});

describe('routes and moves', () => {
  const items = hubItems(board(), 'p-acme');

  it('finds the route’s item, a Claude terminal’s link landing on its session', () => {
    expect(routeItem(items, { sessionId: 's-work' })?.key).toBe('s:s-work');
    expect(routeItem(items, { terminalId: 't-claude' })?.key).toBe('s:s-term');
    expect(routeItem(items, { terminalId: 't-dev' })?.key).toBe('t:t-dev');
    expect(routeItem(items, { sessionId: 'gone' })).toBeNull();
    expect(routeItem(items, {})).toBeNull();
  });

  it('links each card to its session or terminal route', () => {
    const [first, , dev] = items;
    if (!first || !dev) throw new Error('missing items');
    expect(itemHref('p-acme', first)).toBe('/p/p-acme/s/s-wait');
    expect(itemHref('p-acme', dev)).toBe('/p/p-acme/t/t-dev');
  });

  it('swipes to the neighbouring card and stops at the ends', () => {
    expect(neighbour(items, 's:s-work', 1)?.key).toBe('t:t-dev');
    expect(neighbour(items, 's:s-work', -1)?.key).toBe('s:s-wait');
    expect(neighbour(items, 's:s-wait', -1)).toBeNull();
    expect(neighbour(items, 't:t-idle', 1)).toBeNull();
  });

  it('points the amber bar at another card that needs the user', () => {
    expect(otherNeedsYou(items, 's:s-work')?.key).toBe('s:s-wait');
    expect(otherNeedsYou(items, 's:s-wait')).toBeNull();
  });
});

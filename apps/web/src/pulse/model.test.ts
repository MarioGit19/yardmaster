import { type ActivityEvent, type ActivityKind, PULSE_WINDOW_MS } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { makeTerminal, sampleBoard } from '../test/board.js';
import {
  buildLanes,
  eventLabel,
  eventTone,
  formatAgo,
  hitTest,
  matchesFilter,
  placeDots,
  pulseLayout,
  pulseSession,
  pulseTarget,
  stepDot,
  timeToX,
} from './model.js';

// Synthetic sample data only.
const NOW = 1_760_000_000_000;

function event(
  id: string,
  kind: ActivityKind,
  partial: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id,
    ts: NOW - 60_000,
    kind,
    projectId: 'p-acme',
    sessionId: null,
    terminalId: null,
    execId: null,
    summary: null,
    data: {},
    ...partial,
  };
}

describe('event tones and labels', () => {
  it('colors events by type', () => {
    expect(eventTone(event('a', 'tool.error'))).toBe('err');
    expect(eventTone(event('a', 'stop.failure'))).toBe('err');
    expect(eventTone(event('a', 'exec.end', { data: { exitCode: 2 } }))).toBe('err');
    expect(eventTone(event('a', 'exec.end', { data: { exitCode: 0 } }))).toBe('ok');
    expect(eventTone(event('a', 'exec.end', { data: { exitCode: 130 } }))).toBe('idle');
    expect(eventTone(event('a', 'permission.request'))).toBe('wait');
    expect(eventTone(event('a', 'tool.start'))).toBe('tool');
    expect(eventTone(event('a', 'prompt'))).toBe('work');
    expect(eventTone(event('a', 'stop'))).toBe('ok');
    expect(eventTone(event('a', 'session.end'))).toBe('idle');
  });

  it('labels exits with their code', () => {
    expect(eventLabel(event('a', 'exec.end', { data: { exitCode: 1 } }))).toBe('Exited 1');
    expect(eventLabel(event('a', 'exec.end', { data: { exitCode: 130 } }))).toBe('Interrupted');
    expect(eventLabel(event('a', 'exec.end', { data: { exitCode: 'x' } }))).toBe(
      'Command finished',
    );
  });

  it('filters by source and errors', () => {
    const tool = event('a', 'tool.start');
    const exec = event('b', 'exec.start');
    const failed = event('c', 'exec.end', { data: { exitCode: 1 } });
    expect([tool, exec, failed].filter((e) => matchesFilter(e, 'all'))).toHaveLength(3);
    expect([tool, exec, failed].filter((e) => matchesFilter(e, 'claude'))).toEqual([tool]);
    expect([tool, exec, failed].filter((e) => matchesFilter(e, 'terminals'))).toEqual([
      exec,
      failed,
    ]);
    expect([tool, exec, failed].filter((e) => matchesFilter(e, 'errors'))).toEqual([failed]);
  });
});

describe('lanes', () => {
  const board = sampleBoard();
  const since = NOW - PULSE_WINDOW_MS;

  it('keeps one lane per project in name order, with an Other lane only when used', () => {
    const lanes = buildLanes(
      [
        event('a', 'prompt', { projectId: 'p-zen' }),
        event('old', 'prompt', { ts: since - 1 }),
        event('b', 'exec.start', { projectId: 'p-orbit' }),
      ],
      board.projects,
      'all',
      since,
    );
    expect(lanes.map((l) => l.name)).toEqual(['acme-shop', 'orbit-api', 'zen-notes']);
    expect(lanes.map((l) => l.events.map((e) => e.id))).toEqual([[], ['b'], ['a']]);

    const withOther = buildLanes(
      [event('x', 'prompt', { projectId: null }), event('y', 'prompt', { projectId: 'gone' })],
      board.projects,
      'all',
      since,
    );
    expect(withOther.at(-1)).toMatchObject({ projectId: null, name: 'Other', accent: null });
    expect(withOther.at(-1)?.events.map((e) => e.id)).toEqual(['x', 'y']);
  });

  it('maps the window onto the plot, newest at the right', () => {
    const layout = pulseLayout(1000, 3);
    expect(timeToX(NOW, NOW, layout)).toBe(layout.plotRight);
    expect(timeToX(NOW - PULSE_WINDOW_MS, NOW, layout)).toBeCloseTo(layout.plotLeft);
    expect(layout.height).toBe(4 + 3 * 22 + 18);
  });

  it('hit-tests within the hovered lane, preferring the nearest dot', () => {
    const lanes = buildLanes(
      [
        event('a', 'prompt', { ts: NOW - 60_000 }),
        event('b', 'stop', { ts: NOW - 55_000 }),
        event('c', 'exec.start', { projectId: 'p-orbit', ts: NOW - 60_000 }),
      ],
      board.projects,
      'all',
      since,
    );
    const layout = pulseLayout(1000, lanes.length);
    const dots = placeDots(lanes, NOW, layout);
    const b = dots.find((d) => d.event.id === 'b');
    if (!b) throw new Error('no dot b');
    expect(hitTest(dots, b.x + 1, b.y, layout)?.event.id).toBe('b');
    // The same x on the next lane finds that lane's dot, not this one.
    const c = dots.find((d) => d.event.id === 'c');
    expect(hitTest(dots, c?.x ?? 0, (c?.y ?? 0) + 3, layout)?.event.id).toBe('c');
    expect(hitTest(dots, b.x + 40, b.y, layout)).toBeNull();
  });

  it('steps between dots with the keyboard', () => {
    const lanes = buildLanes(
      [
        event('a1', 'prompt', { ts: NOW - 300_000 }),
        event('a2', 'stop', { ts: NOW - 100_000 }),
        event('o1', 'exec.start', { projectId: 'p-orbit', ts: NOW - 120_000 }),
        event('z1', 'exec.start', { projectId: 'p-zen', ts: NOW - 280_000 }),
      ],
      board.projects,
      'all',
      since,
    );
    const dots = placeDots(lanes, NOW, pulseLayout(1000, lanes.length));
    expect(stepDot(dots, null, 'ArrowLeft')).toBe('a2');
    expect(stepDot(dots, 'a2', 'ArrowLeft')).toBe('o1');
    expect(stepDot(dots, 'a2', 'ArrowRight')).toBe('a2');
    expect(stepDot(dots, 'a2', 'Home')).toBe('a1');
    expect(stepDot(dots, 'a2', 'ArrowDown')).toBe('o1');
    expect(stepDot(dots, 'o1', 'ArrowDown')).toBe('z1');
    expect(stepDot(dots, 'a1', 'ArrowUp')).toBe('a1');
    expect(stepDot(dots, 'a1', 'Tab')).toBeUndefined();
    expect(stepDot([], null, 'End')).toBeNull();
  });
});

describe('navigation targets', () => {
  const board = sampleBoard();

  it('goes to the session, else the terminal, else the project', () => {
    expect(pulseTarget(event('a', 'prompt', { sessionId: 's-1' }), board)).toEqual({
      href: '/p/p-acme/s/s-1',
    });
    expect(
      pulseTarget(event('b', 'exec.end', { projectId: 'p-zen', terminalId: 't-1' }), board),
    ).toEqual({ href: '/p/p-zen', terminal: { projectId: 'p-zen', terminalId: 't-1' } });
    expect(pulseTarget(event('c', 'prompt', { sessionId: 'gone' }), board)).toEqual({
      href: '/p/p-acme',
    });
    expect(pulseTarget(event('d', 'prompt', { projectId: 'gone' }), board)).toBeNull();
  });

  it("opens a Claude terminal's session for its terminal events", () => {
    const linked = sampleBoard();
    linked.terminals['t-claude'] = makeTerminal('t-claude', 'p-acme');
    const session = linked.sessions['s-1'];
    if (!session) throw new Error('missing session');
    linked.sessions['s-1'] = { ...session, terminalId: 't-claude' };
    const exec = event('e', 'exec.start', { projectId: 'p-acme', terminalId: 't-claude' });
    expect(pulseSession(exec, linked)?.id).toBe('s-1');
    expect(pulseTarget(exec, linked)).toEqual({ href: '/p/p-acme/s/s-1' });
    expect(
      pulseSession(event('f', 'exec.end', { projectId: 'p-zen', terminalId: 't-1' }), linked),
    ).toBeUndefined();
  });
});

describe('formatAgo', () => {
  it('reads like a timestamp caption', () => {
    expect(formatAgo(2_000)).toBe('just now');
    expect(formatAgo(42_000)).toBe('42s ago');
    expect(formatAgo(130_000)).toBe('2m 10s ago');
    expect(formatAgo(600_000)).toBe('10m ago');
  });
});

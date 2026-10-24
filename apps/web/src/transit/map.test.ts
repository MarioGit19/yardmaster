import type { ActivityEvent, ActivityKind } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import type { ActorState, SceneActor } from '../layouts/scene.js';
import {
  BIN_PX,
  binHeight,
  binTarget,
  boardRows,
  boardStatus,
  buildServiceLog,
  busiestLine,
  eventKind,
  lineStations,
  MIN_COLUMNS,
  PHONE_BELOW,
  placeBins,
  SLOT_MIN,
  slotCount,
  TRAIN_AT,
  TRANSIT_WINDOW_MS,
  trainMotion,
  transitMode,
  WIDE_FROM,
} from './map.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function event(
  id: string,
  kind: ActivityKind,
  ts: number,
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id,
    ts,
    kind,
    projectId: 'p1',
    sessionId: 's1',
    terminalId: null,
    execId: null,
    summary: null,
    data: {},
    ...overrides,
  };
}

function actor(id: string, overrides: Partial<SceneActor> = {}): SceneActor {
  return {
    id,
    kind: 'terminal',
    projectId: 'p1',
    parentId: null,
    state: 'idle',
    tone: 'idle',
    activity: 0,
    label: id,
    caption: { glyph: null, text: 'Idle', tone: 'rest' },
    name: id,
    links: { href: '#', sessionId: null, terminalId: null, approvalId: null },
    since: 0,
    tool: null,
    toolSince: null,
    planning: false,
    ports: [],
    runningSince: null,
    exit: null,
    ...overrides,
  };
}

const project = (
  overrides: { commits?: { hash: string; at: number; subject: string }[] } = {},
) => ({
  id: 'p1',
  commits: [],
  actors: [] as SceneActor[],
  ...overrides,
});

describe('the concourse', () => {
  it('stands the board beside the map when wide, above it when not, and lists on a phone', () => {
    expect(transitMode(390)).toBe('phone');
    expect(transitMode(PHONE_BELOW - 1)).toBe('phone');
    expect(transitMode(PHONE_BELOW)).toBe('stacked');
    expect(transitMode(WIDE_FROM - 1)).toBe('stacked');
    expect(transitMode(WIDE_FROM)).toBe('wide');
    // The demo at 1440: a map about 750 px wide holds five stations a line.
    expect(slotCount(750)).toBe(5);
    expect(slotCount(SLOT_MIN - 1)).toBe(1);
    // A wide map spreads to the busiest line's stations, never fewer than four columns.
    expect(slotCount(1150, 5)).toBe(5);
    expect(slotCount(1150, 1)).toBe(MIN_COLUMNS);
    expect(slotCount(1150, 20)).toBe(8);
    expect(
      busiestLine([{ actors: [actor('t:1'), actor('s:1', { kind: 'claude' })] }, { actors: [] }]),
    ).toBe(2);
  });
});

describe('stations', () => {
  const session = (id: string, state: ActorState, since: number) =>
    actor(id, { kind: 'claude', state, since });
  const terminal = (id: string, state: ActorState, since: number) =>
    actor(id, { kind: 'terminal', state, since });

  it('gives each session and terminal a station in a stable order, subagents on its spur', () => {
    const { stations, hidden } = lineStations(
      [
        terminal('t:old', 'running', 1),
        session('s:b', 'waiting', 5),
        actor('b:s:b:1', { kind: 'subagent', parentId: 's:b', state: 'thinking' }),
        session('s:a', 'idle', 2),
        terminal('t:new', 'error', 9),
      ],
      8,
    );
    expect(stations.map((s) => s.actor.id)).toEqual(['s:a', 's:b', 't:old', 't:new']);
    expect(stations[1]?.minis.map((m) => m.id)).toEqual(['b:s:b:1']);
    expect(hidden).toBe(0);
  });

  it('keeps the ones that need you when not all fit, leaving the last slot to "+N"', () => {
    const actors = [
      session('s:1', 'idle', 1),
      session('s:2', 'idle', 2),
      terminal('t:1', 'idle', 3),
      terminal('t:2', 'waiting', 4),
      terminal('t:3', 'error', 5),
    ];
    const { stations, hidden } = lineStations(actors, 3);
    expect(stations.map((s) => s.actor.id)).toEqual(['t:2', 't:3']);
    expect(hidden).toBe(3);
    // Everything fits: no "+N".
    expect(lineStations(actors, 5).hidden).toBe(0);
  });
});

describe('trains', () => {
  it('glides when working, opens doors when waiting, stops on an error, parks otherwise', () => {
    expect(trainMotion('typing')).toBe('glide');
    expect(trainMotion('waiting')).toBe('wait');
    expect(trainMotion('error')).toBe('stop');
    expect(trainMotion('serving')).toBe('park');
    // A working train pulls out of the platform; a failed one halts short of it.
    expect(TRAIN_AT.glide).toBeGreaterThan(TRAIN_AT.stop);
    expect(TRAIN_AT.stop).toBeGreaterThan(TRAIN_AT.park);
    expect(TRAIN_AT.wait).toBe(TRAIN_AT.park);
  });
});

describe('the departures board', () => {
  it('words each state like a station board', () => {
    expect(boardStatus({ state: 'waiting', tone: 'wait', exit: null })).toEqual({
      word: 'Due · needs you',
      tone: 'wait',
    });
    expect(boardStatus({ state: 'error', tone: 'err', exit: 2 })).toEqual({
      word: 'Cancelled · exit 2',
      tone: 'err',
    });
    expect(boardStatus({ state: 'typing', tone: 'tool', exit: null }).word).toBe('Departing');
    expect(boardStatus({ state: 'serving', tone: 'ok', exit: null }).word).toBe('In service');
    expect(boardStatus({ state: 'idle', tone: 'idle', exit: null }).word).toBe('At platform');
  });

  it('lists what needs you first across projects, then work, in project order, capped', () => {
    const projects = [
      {
        id: 'p1',
        name: 'acme-shop',
        accent: 1 as const,
        actors: [
          actor('t:a', { state: 'running', projectId: 'p1' }),
          actor('b:x', { kind: 'subagent', parentId: 's:z', state: 'thinking', projectId: 'p1' }),
          actor('t:b', { state: 'idle', projectId: 'p1' }),
        ],
      },
      {
        id: 'p2',
        name: 'docs-site',
        accent: 2 as const,
        actors: [
          actor('s:w', { kind: 'claude', state: 'waiting', projectId: 'p2' }),
          actor('t:c', { state: 'error', projectId: 'p2' }),
        ],
      },
    ];
    const { rows, hidden, due, departing } = boardRows(projects, 3);
    expect(rows.map((r) => r.actor.id)).toEqual(['s:w', 't:c', 't:a']);
    expect(rows[0]?.project.name).toBe('docs-site');
    expect(hidden).toBe(1);
    expect(due).toBe(1);
    expect(departing).toBe(1);
  });
});

describe('the service log', () => {
  it('logs finished turns, exits and crashes, and skips the rest', () => {
    expect(eventKind(event('a', 'stop', NOW))).toBe('turn');
    expect(eventKind(event('b', 'stop.failure', NOW))).toBe('crash');
    expect(eventKind(event('c', 'exec.end', NOW, { data: { exitCode: 0 } }))).toBe('ok');
    expect(eventKind(event('d', 'exec.end', NOW, { data: { exitCode: 2 } }))).toBe('fail');
    // Ctrl+C is the user stopping it.
    expect(eventKind(event('e', 'exec.end', NOW, { data: { exitCode: 130 } }))).toBeNull();
    expect(eventKind(event('f', 'tool.start', NOW))).toBeNull();
  });

  it('collects the hour per project with its commits, oldest first', () => {
    const log = buildServiceLog(
      [
        event('old', 'stop', NOW - TRANSIT_WINDOW_MS - 1),
        event('t1', 'stop', NOW - 20 * MIN),
        event('x', 'exec.end', NOW - 5 * MIN, { data: { exitCode: 1 } }),
        event('other', 'stop', NOW - MIN, { projectId: 'p2' }),
        event('orphan', 'stop', NOW - MIN, { projectId: null }),
        event('tool', 'tool.end', NOW - MIN),
      ],
      [
        project({
          commits: [
            { hash: 'abcdef1234', at: NOW - 10 * MIN, subject: 'Fix totals' },
            { hash: 'old', at: NOW - 2 * TRANSIT_WINDOW_MS, subject: 'Too old' },
          ],
        }),
      ],
      NOW,
    );
    const list = log.get('p1') ?? [];
    expect(list.map((s) => [s.id, s.kind])).toEqual([
      ['t1', 'turn'],
      ['commit:abcdef1234', 'commit'],
      ['x', 'fail'],
    ]);
    expect(list[1]).toMatchObject({ label: 'Commit abcdef1', detail: 'Fix totals', event: null });
    expect(log.has('p2')).toBe(false);
  });

  it('puts the hour in fixed bins: one stop each, the worst kind, a bin apart', () => {
    // 240 px: ten bins of six minutes.
    const width = 10 * BIN_PX;
    const binMs = TRANSIT_WINDOW_MS / 10;
    const at = Math.floor(NOW / binMs) * binMs;
    const log = buildServiceLog(
      [
        event('a', 'stop', at + 1),
        event('b', 'exec.end', at + 2, { data: { exitCode: 1 } }),
        event('c', 'stop', at + 3),
        event('d', 'stop', at - binMs + 1),
        event('e', 'stop', at - 9 * binMs + 1),
      ],
      [project()],
      NOW,
    );
    const bins = placeBins(log.get('p1') ?? [], NOW, width);
    expect(bins.map((b) => [b.kind, b.events.length, b.x])).toEqual([
      ['turn', 1, BIN_PX / 2],
      ['turn', 1, width - BIN_PX * 1.5],
      ['fail', 3, width - BIN_PX / 2],
    ]);
    const newest = bins.at(-1);
    if (!newest) throw new Error('no bin');
    expect(binTarget(newest).id).toBe('c');
    // A bin keeps its key as "now" moves on, and steps left a bin when its time has passed.
    const later = placeBins(log.get('p1') ?? [], NOW + binMs, width);
    expect(later.find((b) => b.id === newest.id)?.x).toBe(width - BIN_PX * 1.5);
    // The bar grows with the count, up to a cap.
    expect(binHeight(1)).toBe(4);
    expect(binHeight(3)).toBe(8);
    expect(binHeight(40)).toBe(binHeight(5));
  });
});

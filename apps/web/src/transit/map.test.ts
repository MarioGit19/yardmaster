import type { ActivityEvent, ActivityKind } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import type { SceneActor } from '../layouts/scene.js';
import {
  alongAt,
  branchPoints,
  buildBranches,
  buildStations,
  horizontalFrame,
  MERGE_PX,
  placeStops,
  placeTrains,
  point,
  stationKind,
  stopTarget,
  TRAIN,
  TRANSIT_WINDOW_MS,
  trainMotion,
  verticalFrame,
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

describe('frames', () => {
  it('runs the desktop hour left to right with "now" on the right and trains past it', () => {
    const frame = horizontalFrame(3);
    expect(alongAt(NOW, NOW, frame)).toBe(frame.nowAt);
    expect(alongAt(NOW - 60 * MIN, NOW, frame)).toBe(frame.startAt);
    expect(alongAt(NOW - 30 * MIN, NOW, frame)).toBeLessThan(frame.nowAt);
    // Later than now is now.
    expect(alongAt(NOW + MIN, NOW, frame)).toBe(frame.nowAt);
    expect(frame.platformAt).toBeGreaterThan(frame.nowAt);
    expect(point(10, 20, frame)).toEqual({ x: 10, y: 20 });
  });

  it('runs the phone hour top to bottom with "now" on top and the trains above it', () => {
    const frame = verticalFrame(4, 358);
    expect(alongAt(NOW - 60 * MIN, NOW, frame)).toBe(frame.startAt);
    expect(frame.startAt).toBeGreaterThan(frame.nowAt);
    expect(frame.platformAt).toBeLessThan(frame.nowAt);
    expect(point(10, 20, frame)).toEqual({ x: 20, y: 10 });
    // Columns share the width but stay wide enough to tap.
    expect(frame.lineGap).toBe(89);
    expect(verticalFrame(9, 358).lineGap).toBe(52);
  });
});

describe('stations', () => {
  it('marks finished turns, exits and crashes, and skips the rest', () => {
    expect(stationKind(event('a', 'stop', NOW))).toBe('turn');
    expect(stationKind(event('b', 'stop.failure', NOW))).toBe('crash');
    expect(stationKind(event('c', 'exec.end', NOW, { data: { exitCode: 0 } }))).toBe('ok');
    expect(stationKind(event('d', 'exec.end', NOW, { data: { exitCode: 2 } }))).toBe('fail');
    // Ctrl+C is the user stopping it.
    expect(stationKind(event('e', 'exec.end', NOW, { data: { exitCode: 130 } }))).toBeNull();
    expect(stationKind(event('f', 'tool.start', NOW))).toBeNull();
  });

  it('collects the hour per project with commits as interchanges, oldest first', () => {
    const stations = buildStations(
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
    const list = stations.get('p1') ?? [];
    expect(list.map((s) => [s.id, s.kind])).toEqual([
      ['t1', 'turn'],
      ['commit:abcdef1234', 'commit'],
      ['x', 'fail'],
    ]);
    expect(list[1]).toMatchObject({ label: 'Commit abcdef1', detail: 'Fix totals', event: null });
    expect(stations.has('p2')).toBe(false);
  });

  it('merges stations closer than 12 px into one stop with the worst kind', () => {
    const frame = horizontalFrame(1);
    const msPerPx = MIN / frame.pxPerMin;
    const stations = buildStations(
      [
        event('a', 'stop', NOW - 30 * MIN),
        event('b', 'exec.end', NOW - 30 * MIN + 5 * msPerPx, { data: { exitCode: 1 } }),
        event('c', 'stop', NOW - 30 * MIN + 10 * msPerPx),
        // Just past 12 px from the first: a stop of its own.
        event('d', 'stop', NOW - 30 * MIN + (MERGE_PX + 0.5) * msPerPx),
        event('e', 'stop', NOW - 5 * MIN),
      ],
      [project()],
      NOW,
    );
    const stops = placeStops(stations.get('p1') ?? [], NOW, frame);
    expect(stops.map((s) => [s.id, s.kind, s.stations.length])).toEqual([
      ['a', 'fail', 3],
      ['d', 'turn', 1],
      ['e', 'turn', 1],
    ]);
    const merged = stops[0];
    if (!merged) throw new Error('no stop');
    expect(merged.along).toBeCloseTo(alongAt(NOW - 30 * MIN + 5 * msPerPx, NOW, frame));
    expect(stopTarget(merged).id).toBe('c');
  });
});

describe('branches', () => {
  const start = (id: string, agent: string, ts: number) =>
    event(id, 'subagent.start', ts, { summary: 'Explore', data: { agentId: agent } });
  const stop = (id: string, agent: string, ts: number) =>
    event(id, 'subagent.stop', ts, { data: { agentId: agent } });

  it('forks at a subagent start and rejoins at its stop, stacking overlaps', () => {
    const branches = buildBranches(
      [
        start('s1', 'a', NOW - 40 * MIN),
        start('s2', 'b', NOW - 38 * MIN),
        stop('e1', 'a', NOW - 35 * MIN),
        stop('e2', 'b', NOW - 30 * MIN),
        start('s3', 'c', NOW - 20 * MIN),
        stop('e3', 'c', NOW - 18 * MIN),
      ],
      [project()],
      NOW,
    ).get('p1');
    expect(branches).toEqual([
      { id: 's1', label: 'Explore', from: NOW - 40 * MIN, to: NOW - 35 * MIN, level: 0 },
      { id: 's2', label: 'Explore', from: NOW - 38 * MIN, to: NOW - 30 * MIN, level: 1 },
      { id: 's3', label: 'Explore', from: NOW - 20 * MIN, to: NOW - 18 * MIN, level: 0 },
    ]);
  });

  it('runs an open branch to now only while its session has a subagent at work', () => {
    const events = [start('s1', 'a', NOW - 4 * MIN)];
    expect(buildBranches(events, [project()], NOW).get('p1')).toEqual([]);
    const busy = {
      ...project(),
      actors: [
        actor('b:s1:a', {
          kind: 'subagent',
          links: { href: '#', sessionId: 's1', terminalId: null, approvalId: null },
        }),
      ],
    };
    expect(buildBranches(events, [busy], NOW).get('p1')).toEqual([
      { id: 's1', label: 'Explore', from: NOW - 4 * MIN, to: null, level: 0 },
    ]);
  });

  it('branches from the window start when the fork fell out of it', () => {
    const branches = buildBranches([stop('e1', 'a', NOW - 50 * MIN)], [project()], NOW);
    expect(branches.get('p1')?.[0]?.from).toBe(NOW - TRANSIT_WINDOW_MS);
  });

  it('leaves the line at 45° and comes back, or peaks when short', () => {
    const frame = horizontalFrame(1);
    const long = branchPoints(
      { id: 'b', label: '', from: NOW - 30 * MIN, to: NOW - 20 * MIN, level: 0 },
      NOW,
      frame,
    );
    expect(long).toHaveLength(4);
    const [a, b, c, d] = long;
    // Above the line on the desktop, at 45°.
    expect(b?.across).toBe(-14);
    expect((b?.along ?? 0) - (a?.along ?? 0)).toBe(14);
    expect((d?.along ?? 0) - (c?.along ?? 0)).toBe(14);
    expect(d?.across).toBe(0);

    const short = branchPoints(
      { id: 'b', label: '', from: NOW - 30 * MIN, to: NOW - 30 * MIN + 30_000, level: 1 },
      NOW,
      frame,
    );
    expect(short).toHaveLength(3);
    expect(short[1]?.across).toBeCloseTo(-7);

    // On the phone: to the right, and an open branch stays out until now.
    const phone = verticalFrame(2, 358);
    const open = branchPoints(
      { id: 'b', label: '', from: NOW - 10 * MIN, to: null, level: 0 },
      NOW,
      phone,
    );
    expect(open.at(-1)).toEqual({ along: phone.nowAt, across: 14 });
  });
});

describe('trains', () => {
  it('glides while working, opens doors while waiting, stops on an error', () => {
    expect(trainMotion('typing')).toBe('glide');
    expect(trainMotion('running')).toBe('glide');
    expect(trainMotion('waiting')).toBe('wait');
    expect(trainMotion('error')).toBe('stop');
    expect(trainMotion('serving')).toBe('park');
    expect(trainMotion('idle')).toBe('park');
  });

  it('queues attention first from now outward, short trains for subagents, then +N', () => {
    const frame = horizontalFrame(1);
    const actors = [
      actor('s:1', { kind: 'claude' }),
      actor('b:1:a', { kind: 'subagent' }),
      actor('t:1'),
      actor('t:2'),
      actor('t:3'),
      actor('t:4'),
    ];
    const { trains, hidden, moreAt } = placeTrains(actors, frame);
    expect(trains.map((t) => [t.actor.id, t.mini, t.slot])).toEqual([
      ['s:1', false, 0],
      ['b:1:a', true, 1],
      ['t:1', false, 2],
      ['t:2', false, 3],
    ]);
    expect(hidden).toBe(2);
    expect(trains[0]?.along).toBe(frame.platformAt + TRAIN.len / 2);
    expect(trains[1]?.along).toBe(frame.platformAt + TRAIN.len + TRAIN.gap + TRAIN.miniLen / 2);
    expect(moreAt).toBeGreaterThan(trains[3]?.along ?? 0);
    expect(moreAt).toBeLessThan(frame.length);

    // On the phone they stack up from now toward the line's name.
    const phone = verticalFrame(1, 358);
    const up = placeTrains(actors, phone);
    expect(up.trains).toHaveLength(3);
    expect(up.trains[0]?.along).toBe(phone.platformAt - TRAIN.len / 2);
    expect(up.moreAt).toBeGreaterThan(0);
  });
});

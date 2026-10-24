import { type ActivityEvent, HISTORY_WINDOW_MS } from '@c-board/protocol';
import { isCrashExit } from '../data/selectors.js';
import type { ActorState, SceneActor, SceneCommit, SceneProject } from '../layouts/scene.js';
import { eventDetail, eventLabel, exitCodeOf } from '../pulse/model.js';

// The Transit map's geometry (DESIGN.md §10.5), pure so it can be tested: one line per project
// across the last hour, stations from the activity history, subagent branches, trains at "now".
// Positions are in two axes: `along` runs with time and `across` steps from line to line, so the
// desktop map (time left → right) and the phone's (lines top → bottom, now on top) share it.

export const TRANSIT_WINDOW_MS = HISTORY_WINDOW_MS;
/**
 * Stations closer than this (px along the line) to a stop merge into it, showing a count. §10.7
 * asks for at least 12 px; a stop's footprint (its 24 px target, and the count pill's ring) needs
 * this much, or a busy hour draws pills on top of each other.
 */
export const MERGE_PX = 24;
/** Below this stage width the lines run top to bottom. */
export const VERTICAL_BELOW = 640;

export type TransitAxis = 'horizontal' | 'vertical';

export interface TransitFrame {
  axis: TransitAxis;
  pxPerMin: number;
  /** `along` of "now". */
  nowAt: number;
  /** +1 when older time lies further along (top to bottom), −1 when it lies before (left). */
  dir: 1 | -1;
  /** `along` of the window's start, an hour ago. */
  startAt: number;
  /** Where the first train parks, and the step from one to the next (signed). */
  platformAt: number;
  /** The content's size: along the lines and across them. */
  length: number;
  breadth: number;
  /** Distance between lines, and the first line's `across`. */
  lineGap: number;
  firstLine: number;
  /** Trains shown per line before a "+N". */
  maxTrains: number;
}

const MINUTE = 60_000;
export const TRAIN = { len: 34, thick: 14, miniLen: 24, miniThick: 10, gap: 8 } as const;
/** Room on both ends of the time axis. */
const PAD = 24;
/** The gap between "now" and the first train. */
const PLATFORM_GAP = 18;
/** The "+N" chip after the trains. */
const MORE = 40;

/** The desktop map: time runs left to right, "now" on the right with the trains past it. */
export function horizontalFrame(lines: number): TransitFrame {
  const pxPerMin = 28;
  const maxTrains = 4;
  const startAt = PAD;
  const nowAt = startAt + 60 * pxPerMin;
  const platformAt = nowAt + PLATFORM_GAP;
  const lineGap = 72;
  const firstLine = 40 + lineGap / 2;
  return {
    axis: 'horizontal',
    pxPerMin,
    nowAt,
    dir: -1,
    startAt,
    platformAt,
    length: platformAt + maxTrains * (TRAIN.len + TRAIN.gap) + MORE + PAD,
    breadth: firstLine + Math.max(1, lines) * lineGap - lineGap / 2,
    lineGap,
    firstLine,
    maxTrains,
  };
}

/** Under each line's name, the platform: trains stack up from "now" toward the names. */
const HEADER = 56;

/**
 * The phone's map: one column per line, "now" at the top with the trains above it, the hour
 * running down. Columns share the width, never narrower than a 44 px tap target plus a gap.
 */
/** The phone's left gutter for the time labels ("−60m"), so no line runs through one (§10.7). */
export const AXIS_GUTTER = 32;

export function verticalFrame(lines: number, width: number): TransitFrame {
  const pxPerMin = 16;
  const maxTrains = 3;
  // At least a 44 px tap target per column.
  const lineGap = Math.max(44, Math.floor((width - AXIS_GUTTER) / Math.max(1, lines)));
  const platform = maxTrains * (TRAIN.len + TRAIN.gap) + MORE;
  const nowAt = HEADER + platform + PLATFORM_GAP;
  return {
    axis: 'vertical',
    pxPerMin,
    nowAt,
    dir: 1,
    startAt: nowAt + 60 * pxPerMin,
    platformAt: nowAt - PLATFORM_GAP,
    length: nowAt + 60 * pxPerMin + PAD,
    breadth: AXIS_GUTTER + Math.max(1, lines) * lineGap,
    lineGap,
    firstLine: AXIS_GUTTER + lineGap / 2,
    maxTrains,
  };
}

/** Lines on one phone screen; more go to the next screen, a swipe away (§10.1). */
export const PHONE_LINES = 4;

export const transitFrame = (axis: TransitAxis, lines: number, width: number) =>
  axis === 'vertical' ? verticalFrame(Math.min(PHONE_LINES, lines), width) : horizontalFrame(lines);

/** The phone's screens of lines, in order: at most `PHONE_LINES` each. */
export function lineGroups<T>(lines: readonly T[], size = PHONE_LINES): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < lines.length; i += size) groups.push(lines.slice(i, i + size));
  return groups;
}

/** Where a moment sits along the lines; later than now is now. */
export function alongAt(ts: number, now: number, frame: TransitFrame): number {
  const minutes = Math.max(0, now - ts) / MINUTE;
  return frame.nowAt + frame.dir * minutes * frame.pxPerMin;
}

export const lineAcross = (index: number, frame: TransitFrame) =>
  frame.firstLine + index * frame.lineGap;

/** Screen x/y of an along/across point. */
export function point(along: number, across: number, frame: TransitFrame) {
  return frame.axis === 'horizontal' ? { x: along, y: across } : { x: across, y: along };
}

/** "−10m" … "−60m", every ten minutes. */
export function ticks(now: number, frame: TransitFrame) {
  return [10, 20, 30, 40, 50, 60].map((minutes) => ({
    minutes,
    along: alongAt(now - minutes * MINUTE, now, frame),
  }));
}

// Stations

export type StationKind = 'turn' | 'ok' | 'fail' | 'commit' | 'crash';

export interface Station {
  id: string;
  kind: StationKind;
  ts: number;
  projectId: string;
  label: string;
  detail: string | null;
  /** The event it marks (null for a commit, which isn't an activity event). */
  event: ActivityEvent | null;
}

/** Which events are worth a stop: finished turns, exits, crashes. Null for the rest. */
export function stationKind(event: ActivityEvent): StationKind | null {
  switch (event.kind) {
    case 'stop':
      return 'turn';
    case 'stop.failure':
      return 'crash';
    case 'exec.end': {
      const code = exitCodeOf(event);
      // Ctrl+C is the user stopping it, not an outcome worth a stop.
      if (code === 130) return null;
      return isCrashExit(code) ? 'fail' : 'ok';
    }
    default:
      return null;
  }
}

/** The worst kind wins when stations merge, so a crash in a busy minute still reads rose. */
const SEVERITY: Record<StationKind, number> = { turn: 0, ok: 1, commit: 2, fail: 3, crash: 4 };

export const worstKind = (kinds: Iterable<StationKind>): StationKind => {
  let worst: StationKind = 'turn';
  for (const kind of kinds) if (SEVERITY[kind] > SEVERITY[worst]) worst = kind;
  return worst;
};

/** Each project's stations inside the window, oldest first. */
export function buildStations(
  events: readonly ActivityEvent[],
  projects: readonly Pick<SceneProject, 'id' | 'commits'>[],
  now: number,
): Map<string, Station[]> {
  const since = now - TRANSIT_WINDOW_MS;
  const byProject = new Map<string, Station[]>(projects.map((p) => [p.id, []]));
  for (const event of events) {
    if (event.ts < since || event.projectId === null) continue;
    const list = byProject.get(event.projectId);
    const kind = stationKind(event);
    if (!list || !kind) continue;
    list.push({
      id: event.id,
      kind,
      ts: Math.min(event.ts, now),
      projectId: event.projectId,
      label: kind === 'turn' ? 'Turn finished' : eventLabel(event),
      detail: eventDetail(event),
      event,
    });
  }
  for (const project of projects) {
    const list = byProject.get(project.id);
    if (!list) continue;
    for (const commit of project.commits) {
      if (commit.at < since || commit.at > now) continue;
      list.push(commitStation(project.id, commit));
    }
    list.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }
  return byProject;
}

function commitStation(projectId: string, commit: SceneCommit): Station {
  return {
    id: `commit:${commit.hash}`,
    kind: 'commit',
    ts: commit.at,
    projectId,
    label: `Commit ${commit.hash.slice(0, 7)}`,
    detail: commit.subject,
    event: null,
  };
}

export interface StationStop {
  /** The oldest member's id: stable while newer stations join. */
  id: string;
  along: number;
  kind: StationKind;
  /** Oldest first. */
  stations: Station[];
}

/**
 * Stations as stops along a line: a station within `MERGE_PX` of the stop before it joins that
 * stop, which then shows a count. A merged stop sits at its members' middle and takes the worst
 * kind; clicking it opens its newest station. Distances are measured from that middle, and a
 * stop only moves on (toward newer time), so two stops never sit closer than `MERGE_PX`.
 */
export function placeStops(
  stations: readonly Station[],
  now: number,
  frame: TransitFrame,
  mergePx = MERGE_PX,
): StationStop[] {
  const stops: StationStop[] = [];
  let current: StationStop | null = null;
  let sum = 0;
  for (const station of stations) {
    const along = alongAt(station.ts, now, frame);
    if (current && Math.abs(along - current.along) < mergePx) {
      current.stations.push(station);
      sum += along;
      current.along = sum / current.stations.length;
      current.kind = worstKind([current.kind, station.kind]);
      continue;
    }
    current = { id: station.id, along, kind: station.kind, stations: [station] };
    sum = along;
    stops.push(current);
  }
  return stops;
}

/** The station a stop opens: its newest. */
export const stopTarget = (stop: StationStop): Station =>
  stop.stations[stop.stations.length - 1] as Station;

// Branches

export interface Branch {
  id: string;
  label: string;
  from: number;
  /** When it rejoined, or null while it still runs (it ends at "now"). */
  to: number | null;
  /** 0 for the first track beside the line, 1 for the next (overlapping branches). */
  level: number;
}

/** Most branches beside one line; more overlapping ones share the outer track. */
const BRANCH_LEVELS = 2;

const agentKey = (event: ActivityEvent): string | null => {
  const id = event.data.agentId ?? event.data.agent_id;
  return typeof id === 'string' && id.length > 0 ? `${event.sessionId ?? ''}|${id}` : null;
};

/**
 * Subagent runs as branch lines, per project: a `subagent.start` forks off, its `subagent.stop`
 * rejoins. One still open runs to "now" only while its session has a subagent at work; a stop
 * whose start fell out of the window branches from the window's start.
 */
export function buildBranches(
  events: readonly ActivityEvent[],
  projects: readonly Pick<SceneProject, 'id' | 'actors'>[],
  now: number,
): Map<string, Branch[]> {
  const since = now - TRANSIT_WINDOW_MS;
  const busy = new Set<string>();
  const known = new Set<string>();
  for (const project of projects) {
    known.add(project.id);
    for (const actor of project.actors) {
      if (actor.kind === 'subagent' && actor.links.sessionId) busy.add(actor.links.sessionId);
    }
  }
  const open = new Map<string, Branch & { projectId: string; sessionId: string | null }>();
  const done: (Branch & { projectId: string })[] = [];
  for (const event of events) {
    if (event.projectId === null || !known.has(event.projectId)) continue;
    if (event.kind !== 'subagent.start' && event.kind !== 'subagent.stop') continue;
    const key = agentKey(event);
    if (!key) continue;
    if (event.kind === 'subagent.start') {
      open.set(key, {
        id: event.id,
        label: event.summary ?? 'Subagent',
        from: event.ts,
        to: null,
        level: 0,
        projectId: event.projectId,
        sessionId: event.sessionId,
      });
      continue;
    }
    const started = open.get(key);
    open.delete(key);
    if (event.ts < since) continue;
    done.push({
      id: started?.id ?? event.id,
      label: started?.label ?? event.summary ?? 'Subagent',
      from: Math.max(started?.from ?? since, since),
      to: event.ts,
      level: 0,
      projectId: event.projectId,
    });
  }
  for (const { sessionId, ...branch } of open.values()) {
    if (sessionId === null || !busy.has(sessionId)) continue;
    done.push({ ...branch, from: Math.max(branch.from, since) });
  }

  const byProject = new Map<string, Branch[]>(projects.map((p) => [p.id, []]));
  for (const { projectId, ...branch } of done.sort((a, b) => a.from - b.from)) {
    const list = byProject.get(projectId);
    if (!list) continue;
    // The first track whose last branch ended before this one starts.
    const ends = new Map<number, number>();
    for (const other of list) {
      ends.set(other.level, Math.max(ends.get(other.level) ?? 0, other.to ?? now));
    }
    let level = 0;
    while (level < BRANCH_LEVELS - 1 && (ends.get(level) ?? -1) >= branch.from) level++;
    list.push({ ...branch, level });
  }
  return byProject;
}

/** How far a branch's track sits beside its line, per level. */
export const BRANCH_OFFSET = 14;

/**
 * A branch's track as along/across points relative to its line: 45° out, along beside the
 * line, 45° back. A short run peaks in a chevron; an open one stays out until "now".
 */
export function branchPoints(
  branch: Branch,
  now: number,
  frame: TransitFrame,
): { along: number; across: number }[] {
  const offset = BRANCH_OFFSET * (branch.level + 1);
  // Beside the line, away from the next one: above on the desktop, right on the phone.
  const side = frame.axis === 'horizontal' ? -1 : 1;
  const a = alongAt(branch.from, now, frame);
  const b = branch.to === null ? frame.nowAt : alongAt(branch.to, now, frame);
  const toward = Math.sign(b - a) || -frame.dir;
  const span = Math.abs(b - a);
  if (branch.to === null) {
    const run = Math.min(offset, span);
    return [
      { along: a, across: 0 },
      { along: a + toward * run, across: side * run },
      { along: b, across: side * run },
    ];
  }
  if (span <= offset * 2) {
    const peak = span / 2;
    return [
      { along: a, across: 0 },
      { along: a + toward * peak, across: side * peak },
      { along: b, across: 0 },
    ];
  }
  return [
    { along: a, across: 0 },
    { along: a + toward * offset, across: side * offset },
    { along: b - toward * offset, across: side * offset },
    { along: b, across: 0 },
  ];
}

// Trains

export type TrainMotion = 'glide' | 'park' | 'wait' | 'stop';

const MOTION: Record<ActorState, TrainMotion> = {
  thinking: 'glide',
  typing: 'glide',
  reading: 'glide',
  running: 'glide',
  delegating: 'glide',
  waiting: 'wait',
  error: 'stop',
  serving: 'park',
  done: 'park',
  idle: 'park',
  watching: 'park',
  sleeping: 'park',
  exited: 'park',
};

/** A working train glides, a waiting one opens amber doors, an errored one stops (§10.5). */
export const trainMotion = (state: ActorState): TrainMotion => MOTION[state];

export interface TrainSlot {
  actor: SceneActor;
  /** Subagents and background tasks run as short trains. */
  mini: boolean;
  /** `along` of the train's middle. */
  along: number;
  /** Its place in the queue, 0 nearest "now". */
  slot: number;
}

/** The line's trains, attention first from "now" outward, and how many didn't fit. */
export function placeTrains(
  actors: readonly SceneActor[],
  frame: TransitFrame,
): { trains: TrainSlot[]; hidden: number; moreAt: number } {
  const step = -frame.dir;
  let edge = frame.platformAt;
  const trains: TrainSlot[] = [];
  for (const actor of actors.slice(0, frame.maxTrains)) {
    const mini = actor.kind === 'subagent' || actor.kind === 'background';
    const len = mini ? TRAIN.miniLen : TRAIN.len;
    trains.push({ actor, mini, along: edge + (step * len) / 2, slot: trains.length });
    edge += step * (len + TRAIN.gap);
  }
  return {
    trains,
    hidden: Math.max(0, actors.length - trains.length),
    moreAt: edge + (step * MORE) / 2 - step * 4,
  };
}

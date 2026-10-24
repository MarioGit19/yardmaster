import { type ActivityEvent, HISTORY_WINDOW_MS } from '@yardmaster/protocol';
import { isCrashExit } from '../data/selectors.js';
import {
  type ActorState,
  actorRank,
  type SceneActor,
  type SceneCommit,
  type SceneProject,
} from '../layouts/scene.js';
import { eventDetail, eventLabel, exitCodeOf } from '../pulse/model.js';
import type { Tone } from '../status.js';

// The Transit concourse's model (DESIGN.md §10.5), pure so it can be tested: the departures
// board's rows, each line's stations (one per session and terminal, with its subagents on a
// spur) and the service log, the last hour's events in fixed bins under the line.

export const TRANSIT_WINDOW_MS = HISTORY_WINDOW_MS;

/** How the concourse is laid out for a stage width. */
export type TransitMode = 'wide' | 'stacked' | 'phone';
/** Below this the lines run top to bottom as station lists, the board above them. */
export const PHONE_BELOW = 640;
/** From this width the board stands beside the map; below, above it. */
export const WIDE_FROM = 1080;

export const transitMode = (width: number): TransitMode =>
  width < PHONE_BELOW ? 'phone' : width < WIDE_FROM ? 'stacked' : 'wide';

// Stations

/** A station's slot along a line on the desktop map: room for its sign and its train. */
export const SLOT_MIN = 132;
/** Stations on one phone line before a "+N more". */
export const PHONE_STATIONS = 6;

export interface LineStation {
  actor: SceneActor;
  /** Its subagents and background tasks, on a spur off the station. */
  minis: SceneActor[];
}

const isTop = (actor: SceneActor) => actor.kind === 'claude' || actor.kind === 'terminal';

/** Sessions, then terminals, oldest first: a state change never moves a station. */
const stable = (a: SceneActor, b: SceneActor) =>
  Number(a.kind === 'terminal') - Number(b.kind === 'terminal') ||
  a.since - b.since ||
  a.id.localeCompare(b.id);

/**
 * A line's stations: one per session and terminal. When more than `max` would fit, the ones that
 * need attention win and the rest count toward "+N"; the chosen keep a stable order (sessions,
 * then terminals, oldest first), so a station stays put while its train's state changes.
 */
export function lineStations(
  actors: readonly SceneActor[],
  max: number,
): { stations: LineStation[]; hidden: number } {
  const tops = actors.filter(isTop);
  const minis = new Map<string, SceneActor[]>();
  for (const actor of actors) {
    if (isTop(actor) || actor.parentId === null) continue;
    const list = minis.get(actor.parentId) ?? [];
    list.push(actor);
    minis.set(actor.parentId, list);
  }
  const room = Math.max(1, max);
  const fits = tops.length <= room;
  // With "+N" taking the last slot, one station fewer.
  const keep = fits ? room : Math.max(1, room - 1);
  const chosen = new Set(
    [...tops]
      .sort((a, b) => actorRank(b.state) - actorRank(a.state) || stable(a, b))
      .slice(0, keep),
  );
  return {
    stations: tops
      .filter((a) => chosen.has(a))
      .sort(stable)
      .map((actor) => ({ actor, minis: minis.get(actor.id) ?? [] })),
    hidden: tops.length - chosen.size,
  };
}

/** Columns a map keeps even when every line is short, so a lone station isn't stretched thin. */
export const MIN_COLUMNS = 4;

/**
 * How many station columns the desktop map has: as many as the busiest line needs (at least
 * `MIN_COLUMNS`), as long as each keeps `SLOT_MIN`. Every line shares them, so stations line up
 * down the map and a wide screen spreads them out instead of leaving the track empty.
 */
export function slotCount(trackWidth: number, busiest = Number.POSITIVE_INFINITY): number {
  const fit = Math.max(1, Math.floor(trackWidth / SLOT_MIN));
  return Math.min(fit, Math.max(MIN_COLUMNS, busiest));
}

/** The most sessions and terminals on one line. */
export const busiestLine = (projects: readonly Pick<SceneProject, 'actors'>[]) =>
  Math.max(0, ...projects.map((p) => p.actors.filter(isTop).length));

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

/** A working train glides out, a waiting one opens amber doors, an errored one stops (§10.5). */
export const trainMotion = (state: ActorState): TrainMotion => MOTION[state];

export const TRAIN = { len: 30, thick: 14, miniLen: 20, miniThick: 10 } as const;

/**
 * Where a train stands past its station mark (px, its middle): at the platform when parked or
 * waiting, pulled out when it works, halted between the two when it failed.
 */
export const TRAIN_AT: Record<TrainMotion, number> = { park: 30, wait: 30, stop: 40, glide: 54 };

// The departures board

/** What the board says about a train, in the station-board words of §10.5. */
export interface BoardStatus {
  word: string;
  tone: Tone;
}

/** What each state reads as on the board. */
export function boardStatus(actor: Pick<SceneActor, 'state' | 'tone' | 'exit'>): BoardStatus {
  switch (actor.state) {
    case 'waiting':
      return { word: 'Due · needs you', tone: 'wait' };
    case 'error':
      return {
        word: actor.exit !== null ? `Cancelled · exit ${actor.exit}` : 'Cancelled',
        tone: 'err',
      };
    case 'thinking':
    case 'typing':
    case 'reading':
    case 'running':
    case 'delegating':
      return { word: 'Departing', tone: actor.tone };
    case 'serving':
      return { word: 'In service', tone: 'ok' };
    case 'done':
      return { word: 'Arrived', tone: 'ok' };
    case 'sleeping':
      return { word: 'Stabled', tone: 'idle' };
    case 'exited':
      return { word: 'Out of service', tone: 'idle' };
    default:
      return { word: 'At platform', tone: 'idle' };
  }
}

export interface BoardRow {
  actor: SceneActor;
  project: Pick<SceneProject, 'id' | 'name' | 'accent'>;
  status: BoardStatus;
}

/**
 * Every session and terminal on the board, the ones that need you first (waiting, then
 * errors, then work), then in the overview's project order. At most `max`, with the rest counted.
 */
export function boardRows(
  projects: readonly Pick<SceneProject, 'id' | 'name' | 'accent' | 'actors'>[],
  max: number,
): { rows: BoardRow[]; hidden: number; due: number; departing: number } {
  const all: (BoardRow & { order: number })[] = [];
  let due = 0;
  let departing = 0;
  for (const project of projects) {
    for (const actor of project.actors) {
      if (!isTop(actor)) continue;
      const status = boardStatus(actor);
      if (actor.state === 'waiting') due++;
      if (trainMotion(actor.state) === 'glide') departing++;
      all.push({
        actor,
        project: { id: project.id, name: project.name, accent: project.accent },
        status,
        order: all.length,
      });
    }
  }
  all.sort((a, b) => actorRank(b.actor.state) - actorRank(a.actor.state) || a.order - b.order);
  const rows = all.slice(0, Math.max(0, max)).map(({ order: _, ...row }) => row);
  return { rows, hidden: all.length - rows.length, due, departing };
}

// The service log

export type EventKind = 'turn' | 'ok' | 'fail' | 'commit' | 'crash';

export interface ServiceEvent {
  id: string;
  kind: EventKind;
  ts: number;
  projectId: string;
  label: string;
  detail: string | null;
  /** The activity event it marks (null for a commit, which isn't one). */
  event: ActivityEvent | null;
}

/** Which events go in the log: finished turns, exits, crashes. Null for the rest. */
export function eventKind(event: ActivityEvent): EventKind | null {
  switch (event.kind) {
    case 'stop':
      return 'turn';
    case 'stop.failure':
      return 'crash';
    case 'exec.end': {
      const code = exitCodeOf(event);
      // Ctrl+C is the user stopping it, not an outcome worth logging.
      if (code === 130) return null;
      return isCrashExit(code) ? 'fail' : 'ok';
    }
    default:
      return null;
  }
}

/** The worst kind wins in a bin, so a crash in a busy minute still reads rose. */
const SEVERITY: Record<EventKind, number> = { turn: 0, ok: 1, commit: 2, fail: 3, crash: 4 };

export const worstKind = (kinds: Iterable<EventKind>): EventKind => {
  let worst: EventKind = 'turn';
  for (const kind of kinds) if (SEVERITY[kind] > SEVERITY[worst]) worst = kind;
  return worst;
};

/** Each project's logged events inside the window, oldest first. */
export function buildServiceLog(
  events: readonly ActivityEvent[],
  projects: readonly Pick<SceneProject, 'id' | 'commits'>[],
  now: number,
): Map<string, ServiceEvent[]> {
  const since = now - TRANSIT_WINDOW_MS;
  const byProject = new Map<string, ServiceEvent[]>(projects.map((p) => [p.id, []]));
  for (const event of events) {
    if (event.ts < since || event.projectId === null) continue;
    const list = byProject.get(event.projectId);
    const kind = eventKind(event);
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
      list.push(commitEvent(project.id, commit));
    }
    list.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }
  return byProject;
}

function commitEvent(projectId: string, commit: SceneCommit): ServiceEvent {
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

/** A bin's width on the desktop log (its target), and on touch screens. */
export const BIN_PX = 24;
export const TOUCH_BIN_PX = 44;

export interface LogBin {
  /** The bin's start in absolute time, so its key holds while "now" moves on. */
  id: string;
  /** Its middle, px from the log's left edge. */
  x: number;
  kind: EventKind;
  /** Oldest first. */
  events: ServiceEvent[];
}

/**
 * The hour as fixed bins `binPx` wide, the newest ending at the right edge; the events in each
 * are one stop (a count, the worst kind), so stops never sit closer than a bin. Bins follow
 * absolute time: as "now" moves on they step left together, and an event keeps its bin.
 */
export function placeBins(
  events: readonly ServiceEvent[],
  now: number,
  width: number,
  binPx = BIN_PX,
): LogBin[] {
  const count = Math.max(1, Math.floor(width / binPx));
  const binMs = TRANSIT_WINDOW_MS / count;
  const nowBin = Math.floor(now / binMs);
  const offset = width - count * binPx;
  const bins = new Map<number, LogBin>();
  for (const event of events) {
    const bin = Math.floor(event.ts / binMs);
    const back = nowBin - bin;
    if (back < 0 || back >= count) continue;
    let found = bins.get(bin);
    if (!found) {
      found = {
        id: String(bin),
        x: offset + (count - 1 - back) * binPx + binPx / 2,
        kind: event.kind,
        events: [],
      };
      bins.set(bin, found);
    }
    found.events.push(event);
    found.kind = worstKind([found.kind, event.kind]);
  }
  return [...bins.values()].sort((a, b) => a.x - b.x);
}

/** The event a bin opens: its newest. */
export const binTarget = (bin: LogBin): ServiceEvent =>
  bin.events[bin.events.length - 1] as ServiceEvent;

/** A bin's bar grows with its count, up to the log's height. */
export const binHeight = (count: number) => 4 + Math.min(Math.max(0, count - 1), 4) * 2;

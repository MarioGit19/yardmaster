import type { OpsState, SceneActor } from '../layouts/scene.js';
import { opsMascotState } from './ops.js';

// Where everyone in an Office room works (DESIGN.md §10.3), in room units: 1 unit is 1 px, the
// back wall meets the floor at `FLOOR`, characters stand 56 px tall. Pure, so the layout and its
// tests agree on every position.

export type StationKind = 'desk' | 'side-desk' | 'rack' | 'bench' | 'couch' | 'bookshelf';
/** Where a terminal ran its command, remembered so done and error play there. */
export type WorkStation = 'bench' | 'rack';

/** The back wall meets the floor here; furniture stands on it. */
export const FLOOR = 184;
export const ROOM_HEIGHT = 220;
/** Furniture is drawn at 3/4 of the kit's size, so a room fits a crew of eight. */
export const FURNITURE_SCALE = 0.75;
export const CHARACTER_PX = 56;
export const MINI_PX = 30;
/** At most this many characters per room; the rest is a "+N" on the door. */
export const MAX_CHARACTERS = 8;
/** Reading or searching this long sends a session to the bookshelf. */
export const READ_TRIP_MS = 3_000;
/** A command running this long is long-running: it moves to a rack (§10.3). */
export const LONG_RUN_MS = 30_000;
/** Rooms are never narrower than this (in units), so the stations keep their spacing. */
export const MIN_ROOM_WIDTH = 340;

/** Stations start right of the door and keep a margin from the right wall. */
const START_X = 62;
const END_PAD = 8;
const GAP = 6;
/** Feet of characters at their station, a step in front of the wall. */
const BACK_ROW = FLOOR + 10;
/** Shared stations (bookshelf, whiteboard) are visited from the front of the room. */
const FRONT_ROW = FLOOR + 30;
/** Sitting on the couch: feet in front of the seat. */
const SEAT_ROW = FLOOR - 8;
const COUCH_SEATS = 2;

const s = (n: number) => Math.round(n * FURNITURE_SCALE);
/** Station footprints, in room units at `FURNITURE_SCALE`. */
const FURNITURE_W: Record<StationKind, number> = {
  desk: s(88),
  'side-desk': s(56),
  rack: s(44),
  bench: s(96),
  couch: s(96),
  bookshelf: s(52),
};
/** The rack's operator stands to its left. */
const RACK_STAND = 36;

/** The whiteboard on the back wall, right of the door, under the nameplate. */
export const WHITEBOARD = { x: 62, y: 60, scale: 0.9 } as const;
/** The whiteboard's width in room units at scale 1 (`kit/Whiteboard`). */
const WHITEBOARD_W = 136;
/** The rack's port tag, in the rack's own units: from 10 left of it to 54 right (`kit/furniture`). */
const RACK_TAG = { from: -10, to: 54 } as const;

/**
 * Whether a rack at `x` (room units, its left edge) can show its port tag on top: not when the tag
 * would land on the whiteboard's bottom line. The room's port sign lists every port anyway.
 */
export function rackTagClear(x: number, whiteboard: boolean): boolean {
  if (!whiteboard) return true;
  const left = x + RACK_TAG.from * FURNITURE_SCALE;
  const right = x + RACK_TAG.to * FURNITURE_SCALE;
  return right <= WHITEBOARD.x || left >= WHITEBOARD.x + WHITEBOARD_W * WHITEBOARD.scale;
}

export interface PlacedStation {
  /** Stable per room: `desk:<actor>`, `rack:<actor>`, `bench:<actor>`, `couch:0`, `side-desk`. */
  key: string;
  kind: StationKind;
  /** Left edge, room units. */
  x: number;
  w: number;
  /** The actor working there (desks, racks, benches), else null. */
  owner: string | null;
}

export interface Placement {
  actorId: string;
  /** The station key it's at, or `whiteboard` / `bookshelf` on a trip. */
  at: string;
  /** Centre of the character, room units. */
  x: number;
  /** Bottom of the character's box. */
  y: number;
  size: number;
  /** Drawn in front of the back row. */
  front: boolean;
}

export interface RoomPlan {
  stations: PlacedStation[];
  placements: Placement[];
  /** Actors not drawn (past 8, or no room left): the door's "+N". */
  hidden: number;
  /** Where each terminal last worked, to pass back in as `previous`. */
  work: Map<string, WorkStation>;
}

export interface PlanOptions {
  /** The room's width in units. */
  width: number;
  now: number;
  /** Where terminals worked on the previous plan. */
  previous?: ReadonlyMap<string, WorkStation>;
  /** Actors under the pointer or focus: they stay drawn while the room is crowded. */
  hold?: ReadonlySet<string>;
}

type Home =
  | { kind: 'desk' }
  | { kind: 'side-desk' }
  | { kind: 'work'; station: WorkStation }
  | { kind: 'couch' };

function terminalHome(
  actor: SceneActor,
  now: number,
  previous: ReadonlyMap<string, WorkStation>,
): Home {
  // A terminal actor's state is always an ops state (scene.ts `opsStateFor`).
  switch (opsMascotState(actor.state as OpsState)) {
    case 'serving':
      return { kind: 'work', station: 'rack' };
    case 'running': {
      const long = actor.runningSince !== null && now - actor.runningSince >= LONG_RUN_MS;
      return {
        kind: 'work',
        station: long || previous.get(actor.id) === 'rack' ? 'rack' : 'bench',
      };
    }
    case 'done':
    case 'error':
      return { kind: 'work', station: previous.get(actor.id) ?? 'bench' };
    default:
      return { kind: 'couch' };
  }
}

function homeOf(actor: SceneActor, now: number, previous: ReadonlyMap<string, WorkStation>): Home {
  if (actor.kind === 'claude') return { kind: 'desk' };
  if (actor.kind === 'terminal') return terminalHome(actor, now, previous);
  return { kind: 'side-desk' };
}

/** Furniture in a stable order (by when each actor started), so a state change slides little. */
const bySince = (a: SceneActor, b: SceneActor) => a.since - b.since || a.id.localeCompare(b.id);

interface Layout {
  stations: PlacedStation[];
  width: number;
}

function layoutStations(
  actors: readonly SceneActor[],
  homes: ReadonlyMap<string, Home>,
  bookshelf: boolean,
): Layout {
  const stable = [...actors].sort(bySince);
  const items: Omit<PlacedStation, 'x'>[] = [];
  for (const actor of stable) {
    if (homes.get(actor.id)?.kind === 'desk')
      items.push({ key: `desk:${actor.id}`, kind: 'desk', w: FURNITURE_W.desk, owner: actor.id });
  }
  const minis = stable.filter((a) => homes.get(a.id)?.kind === 'side-desk').length;
  if (minis > 0) {
    items.push({
      key: 'side-desk',
      kind: 'side-desk',
      w: Math.max(FURNITURE_W['side-desk'], minis * 16 + 10),
      owner: null,
    });
  }
  for (const kind of ['rack', 'bench'] as const) {
    for (const actor of stable) {
      const home = homes.get(actor.id);
      if (home?.kind !== 'work' || home.station !== kind) continue;
      items.push({
        key: `${kind}:${actor.id}`,
        kind,
        w: kind === 'rack' ? RACK_STAND + FURNITURE_W.rack : FURNITURE_W.bench,
        owner: actor.id,
      });
    }
  }
  const sitters = stable.filter((a) => homes.get(a.id)?.kind === 'couch').length;
  for (let i = 0; i < Math.ceil(sitters / COUCH_SEATS); i++)
    items.push({ key: `couch:${i}`, kind: 'couch', w: FURNITURE_W.couch, owner: null });
  if (bookshelf)
    items.push({ key: 'bookshelf', kind: 'bookshelf', w: FURNITURE_W.bookshelf, owner: null });

  let x = START_X;
  const stations = items.map((item) => {
    const placed = { ...item, x };
    x += item.w + GAP;
    return placed;
  });
  return { stations, width: x - GAP - START_X };
}

/** The first `max` actors, with any held ones swapped in for the least urgent. */
function pickShown(
  actors: readonly SceneActor[],
  max: number,
  hold: ReadonlySet<string>,
): SceneActor[] {
  const shown = actors.slice(0, max);
  for (const held of actors.slice(max)) {
    if (!hold.has(held.id)) continue;
    const drop = shown.findLastIndex((a) => !hold.has(a.id));
    if (drop < 0) break;
    shown.splice(drop, 1);
    shown.push(held);
  }
  return shown;
}

/**
 * Lays out one room: a station per Claude session (desk), a shared side desk for subagents and
 * background tasks, a rack per long-running terminal, a bench per one-shot command, couches for
 * idle shells, and a bookshelf when there's room. Then everyone's spot: at their station, or on a
 * trip to the bookshelf (reading for a while) or the whiteboard (planning). Actors that don't fit
 * (past 8, or past the room's width, least urgent first, never a held one) are counted in
 * `hidden`.
 */
export function planRoom(
  actors: readonly SceneActor[],
  { width, now, previous = new Map(), hold = new Set() }: PlanOptions,
): RoomPlan {
  const room = width - START_X - END_PAD;
  let shown = pickShown(actors, MAX_CHARACTERS, hold);
  const homes = new Map<string, Home>();
  for (const actor of actors) homes.set(actor.id, homeOf(actor, now, previous));

  let layout = layoutStations(shown, homes, true);
  if (layout.width > room) layout = layoutStations(shown, homes, false);
  while (layout.width > room && shown.length > 1) {
    const drop = shown.findLastIndex((a) => !hold.has(a.id));
    shown = shown.filter((_, i) => i !== (drop < 0 ? shown.length - 1 : drop));
    layout = layoutStations(shown, homes, false);
  }
  const { stations } = layout;
  const byKey = new Map(stations.map((st) => [st.key, st]));
  const bookshelf = byKey.get('bookshelf');

  const placements: Placement[] = [];
  const work = new Map<string, WorkStation>();
  let mini = 0;
  let sitter = 0;
  for (const actor of shown) {
    const home = homes.get(actor.id);
    if (!home) continue;
    if (home.kind === 'desk') {
      const desk = byKey.get(`desk:${actor.id}`);
      if (!desk) continue;
      const reading =
        actor.state === 'reading' &&
        actor.toolSince !== null &&
        now - actor.toolSince >= READ_TRIP_MS;
      if (actor.planning && actor.state !== 'waiting' && actor.state !== 'error') {
        placements.push(spot(actor.id, 'whiteboard', WHITEBOARD.x + 8, FRONT_ROW, true));
      } else if (reading && bookshelf) {
        placements.push(
          spot(actor.id, 'bookshelf', bookshelf.x + bookshelf.w / 2, FRONT_ROW, true),
        );
      } else {
        placements.push(spot(actor.id, desk.key, desk.x + 50, BACK_ROW));
      }
    } else if (home.kind === 'side-desk') {
      const desk = byKey.get('side-desk');
      if (!desk) continue;
      placements.push({
        actorId: actor.id,
        at: desk.key,
        x: desk.x + 12 + mini * 16,
        y: BACK_ROW - 2,
        size: MINI_PX,
        front: false,
      });
      mini++;
    } else if (home.kind === 'work') {
      const station = byKey.get(`${home.station}:${actor.id}`);
      if (!station) continue;
      work.set(actor.id, home.station);
      const x = home.station === 'rack' ? station.x + RACK_STAND / 2 : station.x + 52;
      placements.push(spot(actor.id, station.key, x, BACK_ROW));
    } else {
      const couch = byKey.get(`couch:${Math.floor(sitter / COUCH_SEATS)}`);
      if (!couch) continue;
      const seat = sitter % COUCH_SEATS;
      placements.push(spot(actor.id, couch.key, couch.x + 22 + seat * 28, SEAT_ROW));
      sitter++;
    }
  }
  return { stations, placements, hidden: actors.length - placements.length, work };
}

function spot(actorId: string, at: string, x: number, y: number, front = false): Placement {
  return { actorId, at, x, y, size: CHARACTER_PX, front };
}

/** Columns and room width for a building `width` px wide (§10.3: 1 at 390, 3–4 at 1440, 4–5 at 1920). */
export function buildingColumns(width: number, max = 5): { columns: number; room: number } {
  const columns = Math.max(1, Math.min(max, Math.floor(width / MIN_ROOM_WIDTH)));
  return { columns, room: width / columns };
}

/** How long a walk takes: 600–900 ms with the distance (§10.3). */
export function walkSeconds(distance: number): number {
  return 0.6 + 0.3 * Math.min(1, Math.abs(distance) / 240);
}

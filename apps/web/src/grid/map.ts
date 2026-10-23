import { toolFamily } from '@c-board/protocol';
import type { SceneActor, SceneProject } from '../layouts/scene.js';
import { loop } from '../motion.js';
import { FAMILY_TOKEN } from '../orb/model.js';
import type { Caption } from '../pod/model.js';

// The Grid's 2D map (DESIGN.md §10.4 "2D map"): the core in the middle, a node per project on a
// ring around it (attention first, clockwise from the top), a straight pipeline from the core to
// each node. Pure geometry and choices, so the layout is testable without a browser.

/** Below this width the map becomes one trunk with the nodes listed down it. */
export const TRUNK_BELOW = 720;
/** A node's label card, px. Every node gets the same box, so the ring stays even. */
export const NODE_W = 216;
export const NODE_H = 112;
/** Where the hexagon sits inside the card: its center, from the card's top left. */
export const HEX_AT = { x: 30, y: 30 } as const;
export const HEX_R = 13;
export const CORE_R = 26;
/** Room kept between cards, and around the map's edge. */
const GAP = 16;
const EDGE = 16;
const MIN_RY = 170;
const MAX_RY = 1_400;
const RY_STEP = 10;
const SAMPLES = 720;

export interface Point {
  x: number;
  y: number;
}

export interface MapPlan {
  width: number;
  height: number;
  core: Point;
  /** Card centers, in scene order. */
  nodes: Point[];
}

/** Points on an ellipse at equal arc lengths, starting at the top and going clockwise. */
function ellipsePoints(count: number, center: Point, rx: number, ry: number): Point[] {
  if (count === 0) return [];
  const at = (t: number): Point => ({
    x: center.x + rx * Math.cos(t - Math.PI / 2),
    y: center.y + ry * Math.sin(t - Math.PI / 2),
  });
  const lengths = [0];
  let previous = at(0);
  for (let i = 1; i <= SAMPLES; i++) {
    const point = at((i / SAMPLES) * 2 * Math.PI);
    lengths.push((lengths[i - 1] ?? 0) + Math.hypot(point.x - previous.x, point.y - previous.y));
    previous = point;
  }
  const total = lengths[SAMPLES] ?? 0;
  const points: Point[] = [];
  let sample = 0;
  for (let k = 0; k < count; k++) {
    const want = (k / count) * total;
    while (sample < SAMPLES && (lengths[sample + 1] ?? total) < want) sample++;
    const from = lengths[sample] ?? 0;
    const to = lengths[sample + 1] ?? total;
    const f = to > from ? (want - from) / (to - from) : 0;
    points.push(at(((sample + f) / SAMPLES) * 2 * Math.PI));
  }
  return points;
}

/** Two cards centered on `a` and `b` overlap (with the gap between them). */
export function cardsOverlap(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < NODE_W + GAP && Math.abs(a.y - b.y) < NODE_H + GAP;
}

/** A card would cover the core. */
const coversCore = (node: Point, core: Point) =>
  Math.abs(node.x - core.x) < NODE_W / 2 + CORE_R + GAP &&
  Math.abs(node.y - core.y) < NODE_H / 2 + CORE_R + GAP;

/**
 * The map for `count` projects in a stage `width` px wide: the ring is as wide as the stage
 * allows, and as tall as it needs to be for no two labels to overlap.
 */
export function planMap(count: number, width: number): MapPlan {
  const rx = Math.max(0, width / 2 - NODE_W / 2 - EDGE);
  let ry = MIN_RY;
  let nodes: Point[] = [];
  for (; ry <= MAX_RY; ry += RY_STEP) {
    const center = { x: width / 2, y: ry + NODE_H / 2 + EDGE };
    nodes = ellipsePoints(count, center, rx, ry);
    const clear = nodes.every(
      (a, i) => !coversCore(a, center) && nodes.every((b, j) => j <= i || !cardsOverlap(a, b)),
    );
    if (clear) break;
  }
  ry = Math.min(ry, MAX_RY);
  const core = { x: width / 2, y: ry + NODE_H / 2 + EDGE };
  return { width, height: 2 * ry + NODE_H + 2 * EDGE, core, nodes };
}

/** The hexagon's center for a card centered on `node`. */
export const hexCenter = (node: Point): Point => ({
  x: node.x - NODE_W / 2 + HEX_AT.x,
  y: node.y - NODE_H / 2 + HEX_AT.y,
});

export interface Segment {
  /** Where packets start, and the angle (deg) and length (px) they travel. */
  x: number;
  y: number;
  angle: number;
  length: number;
}

/** The visible run of a pipeline from `from` to `to`, trimmed by each end's radius. */
export function segment(from: Point, to: Point, trimFrom: number, trimTo: number): Segment {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const full = Math.hypot(dx, dy);
  const length = Math.max(0, full - trimFrom - trimTo);
  const ux = full > 0 ? dx / full : 0;
  const uy = full > 0 ? dy / full : 0;
  return {
    x: from.x + ux * trimFrom,
    y: from.y + uy * trimFrom,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    length,
  };
}

export interface PacketFlow {
  /** Packets in flight on the pipeline at once. */
  count: number;
  /** Seconds for one packet to travel the pipeline. */
  period: number;
}

/**
 * Packets for an activity step (data/activity.ts `levelStep`): more of them and faster as the
 * project gets busier, so the rate follows its throughput (about 0.4, 1.1 and 2.7 a second).
 */
export function packetFlow(step: 0 | 1 | 2 | 3): PacketFlow {
  switch (step) {
    case 0:
      return { count: 0, period: loop.packetCalm };
    case 1:
      return { count: 1, period: loop.packetCalm };
    case 2:
      return { count: 2, period: loop.packetBusy };
    case 3:
      return { count: 3, period: loop.packetPeak };
  }
}

/** A tool call's burst takes its tool family's color (the orb's, §4.2); other events the neon. */
export function burstColor(tool: string | null): string {
  return `var(${tool ? FAMILY_TOKEN[toolFamily(tool)] : '--grid-neon'})`;
}

/** The tool the project's busiest session is running, for its burst color. */
export function projectTool(project: Pick<SceneProject, 'actors'>): string | null {
  return project.actors.find((a) => a.kind === 'claude' && a.tool)?.tool ?? null;
}

/** The node's live caption: its busiest actor's (actors come attention first), else the summary. */
export function nodeCaption(project: Pick<SceneProject, 'actors' | 'summary'>): Caption {
  const busy = project.actors.find((a) => a.caption.tone !== 'rest');
  if (busy) return busy.caption;
  if (project.summary) return { glyph: null, text: project.summary, tone: 'rest' };
  const first = project.actors[0];
  return first?.caption ?? { glyph: null, text: 'Nothing running', tone: 'rest' };
}

/** "2 Claude · 3 terminals", for the node's counts line. */
export function nodeCounts(actors: readonly Pick<SceneActor, 'kind'>[]): string {
  let claude = 0;
  let terminals = 0;
  let background = 0;
  for (const actor of actors) {
    if (actor.kind === 'claude') claude++;
    else if (actor.kind === 'terminal') terminals++;
    else background++;
  }
  const parts: string[] = [];
  if (claude) parts.push(`${claude} Claude`);
  if (terminals) parts.push(`${terminals} ${terminals === 1 ? 'terminal' : 'terminals'}`);
  if (background) parts.push(`${background} in background`);
  return parts.join(' · ') || 'Nothing running';
}

/** 0..1, the whole board's activity (the core's brightness): two busy projects fill it. */
export function boardEnergy(
  projects: readonly Pick<SceneProject, 'activity' | 'actors'>[],
): number {
  let sum = 0;
  for (const project of projects)
    sum += Math.max(project.activity, ...project.actors.map((a) => a.activity));
  return Math.min(1, sum / 2);
}

/** Satellites drawn on one node; the rest show as "+N" (the room view lists everyone). */
export const MAX_SATELLITES = 8;

export interface CockpitPlan {
  /** The Claude screen in the middle (or the busiest terminal when there's no session). */
  center: SceneActor | null;
  /** Screens to either side, nearest the center first. */
  left: SceneActor[];
  right: SceneActor[];
  /** Subagents and background tasks, by the session they belong to. */
  children: ReadonlyMap<string, SceneActor[]>;
}

/**
 * The flat cockpit's arc (DESIGN.md §10.4 step 3): the main Claude session in the middle, the
 * other sessions and terminals alternating right and left in attention order.
 */
export function planCockpit(actors: readonly SceneActor[]): CockpitPlan {
  const children = new Map<string, SceneActor[]>();
  const screens: SceneActor[] = [];
  for (const actor of actors) {
    if (actor.parentId) {
      const list = children.get(actor.parentId) ?? [];
      list.push(actor);
      children.set(actor.parentId, list);
    } else {
      screens.push(actor);
    }
  }
  const center = screens.find((a) => a.kind === 'claude') ?? screens[0] ?? null;
  const left: SceneActor[] = [];
  const right: SceneActor[] = [];
  for (const actor of screens) {
    if (actor === center) continue;
    (right.length <= left.length ? right : left).push(actor);
  }
  return { center, left, right, children };
}

/** Each step out from the middle of the arc sits this much lower, px. */
export const ARC_DROP = 28;

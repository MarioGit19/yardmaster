import type { SceneActor } from '../layouts/scene.js';
import { MAX_SATELLITES, packetFlow } from './map.js';

// The Grid's 3D network (DESIGN.md §10.4 "Overview (3D)"): the ring of nodes on the floor, the
// satellites around each node, the packets in flight and the camera's limits. Pure numbers in
// world units (y up, the floor at y = 0), so the renderer is a thin drawing layer over them.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The node's hexagonal monolith: its radius, and its height at rest and fully busy. */
export const NODE_R = 1.7;
export const NODE_MIN_H = 1.6;
export const NODE_MAX_H = 3.8;
export const CORE_SIZE = 1.7;
/** How high the core floats, and where its pipelines leave it. */
export const CORE_Y = 2.2;
/** Satellites circle their node this far out, and subagents their session this far. */
export const ORBIT_R = 3.3;
export const CHILD_ORBIT_R = 0.8;
/** At most this many packets in flight at once (DESIGN.md §10.4). */
export const MAX_PACKETS = 400;
/** Phones and tablets draw half as many (§10.1). */
export const TOUCH_MAX_PACKETS = 200;
/** One idle orbit: a revolution per three minutes. */
export const ORBIT_PERIOD_S = 180;

/** The ring's radius for `count` nodes: neighbors stay a label's width apart. */
export function ringRadius(count: number): number {
  return Math.max(16, (count * 13) / (2 * Math.PI));
}

/**
 * Node centers on the floor, attention first and clockwise (seen from above) from the front,
 * where the camera starts (+z).
 */
export function ringPositions(count: number): Vec3[] {
  const r = ringRadius(count);
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * 2 * Math.PI;
    return { x: -r * Math.sin(a), y: 0, z: r * Math.cos(a) };
  });
}

/** A node's height for its activity (0..1). */
export const nodeHeight = (activity: number) =>
  NODE_MIN_H + (NODE_MAX_H - NODE_MIN_H) * Math.min(1, Math.max(0, activity));

/** Moves `current` toward `target` with time constant `tau` ms (frame-rate independent). */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** A pipeline's curve: from the core, arcing up, down to the foot of the node. */
export function pipeControl(node: Vec3): { from: Vec3; mid: Vec3; to: Vec3 } {
  const len = Math.hypot(node.x, node.z) || 1;
  const ux = node.x / len;
  const uz = node.z / len;
  const from = { x: ux * (CORE_SIZE + 0.4), y: CORE_Y, z: uz * (CORE_SIZE + 0.4) };
  const to = { x: node.x - ux * (NODE_R + 0.3), y: 0.6, z: node.z - uz * (NODE_R + 0.3) };
  const mid = { x: (from.x + to.x) / 2, y: CORE_Y + len * 0.12, z: (from.z + to.z) / 2 };
  return { from, mid, to };
}

export interface SatellitePlan {
  actorId: string;
  /** The satellite it circles: null for a node's own (sessions and terminals). */
  parentId: string | null;
  kind: SceneActor['kind'];
  /** Its starting angle on its orbit, rad, and its orbit's radius and height. */
  angle: number;
  radius: number;
  height: number;
}

type ActorShape = Pick<SceneActor, 'id' | 'kind' | 'parentId'>;

/**
 * The satellites a node shows (the first ones in attention order, as on the 2D card), in a
 * stable order: by id, so an attention change never sends them round the node (or moves a
 * focused satellite's button in the DOM).
 */
export function shownSatellites<T extends Pick<SceneActor, 'id'>>(actors: readonly T[]): T[] {
  return actors.slice(0, MAX_SATELLITES).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Where a node's satellites ride: sessions and terminals evenly round the node (the shown ones,
 * plus a slot for the "+N"), subagents and background tasks around their session. A child whose
 * session isn't shown circles the node.
 */
export function planSatellites(actors: readonly ActorShape[]): SatellitePlan[] {
  const shown = shownSatellites(actors);
  const ids = new Set(shown.map((a) => a.id));
  const own = shown.filter((a) => !a.parentId || !ids.has(a.parentId));
  const slots = own.length + (actors.length > shown.length ? 1 : 0);
  const plans: SatellitePlan[] = own.map((actor, i) => ({
    actorId: actor.id,
    parentId: null,
    kind: actor.kind,
    angle: (i / Math.max(1, slots)) * 2 * Math.PI,
    radius: ORBIT_R,
    height: actor.kind === 'terminal' ? 0.8 : 1.4,
  }));
  const children = new Map<string, number>();
  for (const actor of shown) {
    if (!actor.parentId || !ids.has(actor.parentId)) continue;
    const n = children.get(actor.parentId) ?? 0;
    children.set(actor.parentId, n + 1);
    plans.push({
      actorId: actor.id,
      parentId: actor.parentId,
      kind: actor.kind,
      angle: n * 2.1,
      radius: CHILD_ORBIT_R,
      height: 0,
    });
  }
  return plans;
}

/** The "+N" slot's angle on the node's orbit, when the node has more actors than it shows. */
export function moreAngle(actors: readonly ActorShape[]): number | null {
  if (actors.length <= MAX_SATELLITES) return null;
  const shown = actors.slice(0, MAX_SATELLITES);
  const ids = new Set(shown.map((a) => a.id));
  const own = shown.filter((a) => !a.parentId || !ids.has(a.parentId)).length;
  return (own / (own + 1)) * 2 * Math.PI;
}

/** Satellites drift round their node while their actor works; this many rad/s. */
export const SATELLITE_SPIN = 0.18;
export const CHILD_SPIN = 0.9;

export type PacketKind = 'flow' | 'burst' | 'done' | 'beckon';

export interface Packet {
  pipe: string;
  kind: PacketKind;
  /** 0..1 along the pipeline, from the core; `done` packets travel back. */
  t: number;
  /** Seconds to cross the whole pipeline. */
  period: number;
  /** Waits this long (s) before it sets off. */
  delay: number;
  color: string;
}

/** A packet's position along its pipeline, 0 at the core. */
export const packetT = (packet: Packet) => (packet.kind === 'done' ? 1 - packet.t : packet.t);

/** Its size: it swells in at the start and fades out at the end, as the 2D packets do. */
export function packetScale(packet: Packet): number {
  if (packet.delay > 0) return 0;
  const edge = Math.min(packet.t, 1 - packet.t) / 0.12;
  return Math.max(0, Math.min(1, edge));
}

export interface PipeFlow {
  /** The project's activity step (data/activity.ts `levelStep`). */
  step: 0 | 1 | 2 | 3;
  /** An amber pulse toward a waiting node every `beckon` s (§10.4: 2.4 s). */
  waiting: boolean;
}

const BURST_PACKETS = 3;
const BURST_STAGGER_S = 0.09;
/** A burst crosses the pipeline in the spark's time; a beckon in a breath. */
export const BURST_PERIOD_S = 0.9;
export const BECKON_PERIOD_S = 2.4;

/**
 * Every packet in flight (DESIGN.md §10.4): a steady flow out to each node at its activity
 * step's rate, a three-packet burst per event in the tool family's color, one green pulse back
 * to the core per finished turn, and an amber beckon toward a waiting node every 2.4 s. Never
 * more than `max` at once: a full field drops new flow packets first, then new bursts.
 */
export class PacketField {
  readonly packets: Packet[] = [];
  private readonly flows = new Map<string, PipeFlow>();
  /** Seconds until each pipe's next flow packet and next beckon. */
  private readonly nextFlow = new Map<string, number>();
  private readonly nextBeckon = new Map<string, number>();

  constructor(
    private readonly max = MAX_PACKETS,
    private readonly neon = 'neon',
  ) {}

  /** The pipes that exist now and how busy each is; packets on removed pipes are dropped. */
  setFlows(flows: ReadonlyMap<string, PipeFlow>): void {
    for (const pipe of this.flows.keys()) {
      if (!flows.has(pipe)) {
        this.nextFlow.delete(pipe);
        this.nextBeckon.delete(pipe);
      }
    }
    this.flows.clear();
    for (const [pipe, flow] of flows) {
      this.flows.set(pipe, flow);
      if (!this.nextFlow.has(pipe)) this.nextFlow.set(pipe, 0);
      if (!flow.waiting) this.nextBeckon.delete(pipe);
      else if (!this.nextBeckon.has(pipe)) this.nextBeckon.set(pipe, 0);
    }
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const packet = this.packets[i];
      if (packet && !this.flows.has(packet.pipe)) this.packets.splice(i, 1);
    }
  }

  burst(pipe: string, color: string): void {
    for (let i = 0; i < BURST_PACKETS; i++) {
      this.add({
        pipe,
        kind: 'burst',
        t: 0,
        period: BURST_PERIOD_S,
        delay: i * BURST_STAGGER_S,
        color,
      });
    }
  }

  done(pipe: string, color: string): void {
    this.add({ pipe, kind: 'done', t: 0, period: BURST_PERIOD_S * 1.2, delay: 0, color });
  }

  /** Something is in flight, or will be: the renderer keeps drawing every frame. */
  get busy(): boolean {
    if (this.packets.length > 0) return true;
    for (const flow of this.flows.values()) if (flow.step > 0 || flow.waiting) return true;
    return false;
  }

  /** Advances every packet by `dt` seconds and launches the flows' next packets. */
  step(dt: number): void {
    for (const [pipe, flow] of this.flows) {
      const { count, period } = packetFlow(flow.step);
      if (count > 0) {
        let wait = (this.nextFlow.get(pipe) ?? 0) - dt;
        if (wait <= 0) {
          this.add({ pipe, kind: 'flow', t: 0, period, delay: 0, color: this.neon });
          wait += period / count;
          if (wait < 0) wait = period / count;
        }
        this.nextFlow.set(pipe, wait);
      } else {
        this.nextFlow.set(pipe, 0);
      }
      if (flow.waiting) {
        let wait = (this.nextBeckon.get(pipe) ?? 0) - dt;
        if (wait <= 0) {
          this.add({
            pipe,
            kind: 'beckon',
            t: 0,
            period: BECKON_PERIOD_S,
            delay: 0,
            color: 'wait',
          });
          wait = BECKON_PERIOD_S;
        }
        this.nextBeckon.set(pipe, wait);
      }
    }
    let kept = 0;
    for (const packet of this.packets) {
      if (packet.delay > 0) {
        packet.delay = Math.max(0, packet.delay - dt);
      } else {
        packet.t += dt / packet.period;
      }
      if (packet.t < 1) this.packets[kept++] = packet;
    }
    this.packets.length = kept;
  }

  private add(packet: Packet): void {
    if (this.packets.length >= this.max) {
      // Room for an event's packets: the oldest steady-flow packet makes way.
      if (packet.kind === 'flow') return;
      const oldest = this.packets.findIndex((p) => p.kind === 'flow');
      if (oldest < 0) return;
      this.packets.splice(oldest, 1);
    }
    this.packets.push(packet);
  }
}

export interface Orbit {
  /** Around the y axis, rad: 0 looks at the ring's front (from +z). */
  azimuth: number;
  /** From straight above, rad. */
  polar: number;
  distance: number;
}

/** The camera looks down at the ring from about 34° above the floor. */
export const POLAR_HOME = 0.98;
export const POLAR_MIN = 0.55;
export const POLAR_MAX = 1.36;
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 1.6;

/** Room kept above a node for its label, px, and around the stage's edge, as a share of it. */
const LABEL_ROOM = 96;
const FIT_MARGIN = 0.9;

export interface Framing {
  /** The camera's distance from its target at home. */
  distance: number;
  /** A vertical shift of the projection (NDC), so the ring and its labels sit centered. */
  shift: number;
}

/**
 * The camera's home framing for `count` nodes in a `width` × `height` px stage: as close as it
 * can be with every node, its satellites and its label inside the view, at any turn of the idle
 * orbit. Found by projecting the ring and bisecting the distance.
 */
export function homeFraming(
  count: number,
  width: number,
  height: number,
  fovDeg: number,
  target: Vec3,
): Framing {
  const tan = Math.tan((fovDeg * Math.PI) / 360);
  const aspect = width / Math.max(1, height);
  const label = (2 * LABEL_ROOM) / Math.max(1, height);
  const nodes = ringPositions(Math.max(1, count));
  const turns = [0, Math.PI / Math.max(1, count)];
  const measure = (distance: number) => {
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxX = 0;
    for (const azimuth of turns) {
      const eye = orbitPosition(homeOrbit(distance, azimuth), target);
      const f = normalize(sub(target, eye));
      const r = normalize(cross(f, { x: 0, y: 1, z: 0 }));
      const u = cross(r, f);
      const project = (p: Vec3) => {
        const d = sub(p, eye);
        const z = Math.max(0.1, dot(d, f));
        return { x: dot(d, r) / (z * tan * aspect), y: dot(d, u) / (z * tan) };
      };
      for (const node of nodes) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * 2 * Math.PI;
          const foot = project({
            x: node.x + ORBIT_R * Math.sin(a),
            y: 0,
            z: node.z + ORBIT_R * Math.cos(a),
          });
          minY = Math.min(minY, foot.y);
          maxX = Math.max(maxX, Math.abs(foot.x));
        }
        const top = project({ x: node.x, y: NODE_MAX_H, z: node.z });
        maxY = Math.max(maxY, top.y + label);
      }
    }
    return { spanY: (maxY - minY) / 2, center: (maxY + minY) / 2, maxX };
  };
  let near = 10;
  let far = 600;
  for (let i = 0; i < 32; i++) {
    const mid = (near + far) / 2;
    const m = measure(mid);
    if (m.spanY <= FIT_MARGIN && m.maxX <= FIT_MARGIN) far = mid;
    else near = mid;
  }
  return { distance: far, shift: -measure(far).center };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / length, y: a.y / length, z: a.z / length };
};

export interface LabelBox {
  /** The label's anchor (bottom center), px, where its node wants it. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** A smaller, name-only form to fall back to when the full card finds no room. */
  compact?: { width: number; height: number };
}

/** Labels keep at least this much air between them, px. */
const LABEL_GAP = 8;

export interface LabelPlace {
  /** The label's anchor y, px. */
  y: number;
  /** Placed in its compact form: the full card found no room. */
  compact: boolean;
  /**
   * No room for it even compact and lifted to the top (a crowded far side): it stays at its
   * node, hidden until its node is hovered or focused, and nothing else makes way for it.
   */
  crowded: boolean;
}

type Placed = { x: number; y: number; width: number; height: number };

const overlaps = (box: { x: number; width: number }, y: number, height: number, other: Placed) =>
  Math.abs(box.x - other.x) < (box.width + other.width) / 2 + LABEL_GAP &&
  y - height < other.y + LABEL_GAP &&
  y > other.y - other.height - LABEL_GAP;

/** Where a box of this size settles: lifted above every placed label it runs into, or null. */
function lift(
  box: { x: number; y: number; width: number },
  height: number,
  placed: readonly Placed[],
  top: number,
): number | null {
  let y = box.y;
  // Re-check after each lift: rising past one label can run into another.
  for (let pass = 0; pass <= placed.length; pass++) {
    let moved = false;
    for (const other of placed) {
      if (!overlaps(box, y, height, other)) continue;
      y = other.y - other.height - LABEL_GAP;
      moved = true;
    }
    if (!moved) break;
  }
  y = Math.max(y, top + height);
  return placed.some((other) => overlaps(box, y, height, other)) ? null : y;
}

/**
 * Lifts labels clear of each other: from the nearest to the farthest (the order given), each
 * label rises above any nearer one it would overlap. The far side of the ring sits higher on
 * screen, so lifting it only pulls the two further apart. A label that would still overlap one
 * once it hits `top` tries its compact form, and is crowded out if even that finds no room,
 * instead of piling up there.
 */
export function declutter(boxes: readonly LabelBox[], top = 0): LabelPlace[] {
  const placed: Placed[] = [];
  return boxes.map((box) => {
    const full = lift(box, box.height, placed, top);
    if (full !== null) {
      placed.push({ x: box.x, y: full, width: box.width, height: box.height });
      return { y: full, compact: false, crowded: false };
    }
    if (box.compact) {
      const small = { ...box, width: box.compact.width };
      const y = lift(small, box.compact.height, placed, top);
      if (y !== null) {
        placed.push({ x: box.x, y, width: box.compact.width, height: box.compact.height });
        return { y, compact: true, crowded: false };
      }
    }
    return { y: box.y, compact: false, crowded: true };
  });
}

export const homeOrbit = (distance: number, azimuth = 0): Orbit => ({
  azimuth,
  polar: POLAR_HOME,
  distance,
});

/** An orbit turned by a drag of (`dx`, `dy`) px, polar clamped so the floor stays below. */
export function dragOrbit(orbit: Orbit, dx: number, dy: number): Orbit {
  return {
    ...orbit,
    azimuth: orbit.azimuth - dx * 0.006,
    polar: Math.min(POLAR_MAX, Math.max(POLAR_MIN, orbit.polar - dy * 0.004)),
  };
}

/** An orbit zoomed by `factor` (> 1 is out), clamped around the home distance. */
export function zoomOrbit(orbit: Orbit, factor: number, home: number): Orbit {
  return {
    ...orbit,
    distance: Math.min(home * ZOOM_MAX, Math.max(home * ZOOM_MIN, orbit.distance * factor)),
  };
}

/** The camera's position for an orbit around `target`. */
export function orbitPosition(orbit: Orbit, target: Vec3): Vec3 {
  const s = Math.sin(orbit.polar);
  return {
    x: target.x + orbit.distance * s * Math.sin(orbit.azimuth),
    y: target.y + orbit.distance * Math.cos(orbit.polar),
    z: target.z + orbit.distance * s * Math.cos(orbit.azimuth),
  };
}

// --- The dive (§10.4 "Entering a project") --------------------------------------------------

/**
 * The dive ends this far short of the node's center, on its pipeline's line, and this high above
 * its top: hovering over it, with its satellites in view below the cockpit, units.
 */
export const DIVE_STANDOFF = NODE_R + ORBIT_R + 5;
export const DIVE_RISE = 6;
/** How far the dive's fog reaches past the node: its satellites stay, the rest fades out. */
export const DIVE_FOG_DEPTH = ORBIT_R + 3;

export interface DivePath {
  /** The camera's cubic Bézier: from where it is, over the core, along the pipe, to the node. */
  points: readonly [Vec3, Vec3, Vec3, Vec3];
  /** What the camera looks at, at the start and at the end. */
  look: readonly [Vec3, Vec3];
}

/** The flight from the camera's orbit position down a node's pipeline into the node. */
export function divePath(camera: Vec3, look: Vec3, node: Vec3, height: number): DivePath {
  const { from, mid } = pipeControl(node);
  const len = Math.hypot(node.x, node.z) || 1;
  const ux = node.x / len;
  const uz = node.z / len;
  const eye = height + DIVE_RISE;
  const end = { x: node.x - ux * DIVE_STANDOFF, y: eye, z: node.z - uz * DIVE_STANDOFF };
  return {
    points: [
      camera,
      { x: from.x * 0.5, y: from.y + 4, z: from.z * 0.5 },
      // Along the pipe's line, short of the end: the last stretch glides straight in.
      {
        x: node.x - ux * (DIVE_STANDOFF + 1.5),
        y: Math.max(eye, mid.y) + 1,
        z: node.z - uz * (DIVE_STANDOFF + 1.5),
      },
      end,
    ],
    look: [look, { x: node.x, y: Math.max(1, height * 0.5), z: node.z }],
  };
}

const bezier = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The camera at eased progress `k` (0 at the orbit, 1 in the node). The gaze turns to the node
 * in the first 70 %, so the end of the flight looks straight down the pipe.
 */
export function diveAt(path: DivePath, k: number): { position: Vec3; look: Vec3 } {
  const [p0, p1, p2, p3] = path.points;
  const [l0, l1] = path.look;
  const turn = Math.min(1, k / 0.7);
  const g = turn * turn * (3 - 2 * turn);
  return {
    position: {
      x: bezier(p0.x, p1.x, p2.x, p3.x, k),
      y: bezier(p0.y, p1.y, p2.y, p3.y, k),
      z: bezier(p0.z, p1.z, p2.z, p3.z, k),
    },
    look: { x: lerp(l0.x, l1.x, g), y: lerp(l0.y, l1.y, g), z: lerp(l0.z, l1.z, g) },
  };
}

/** The fog at dive progress `k`: from the home framing's to a close wall just past the node. */
export function diveFog(k: number, home: { near: number; far: number }) {
  return {
    near: lerp(home.near, DIVE_STANDOFF, k),
    far: lerp(home.far, DIVE_STANDOFF + DIVE_FOG_DEPTH, k),
  };
}

/** A CSS-style cubic-bezier easing (`ease.inOut` in motion.ts) as a function of progress. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let s = t;
    for (let i = 0; i < 24; i++) {
      s = (lo + hi) / 2;
      if (bezier(0, x1, x2, 1, s) < t) lo = s;
      else hi = s;
    }
    return bezier(0, y1, y2, 1, s);
  };
}

import { describe, expect, it } from 'vitest';
import { ease } from '../motion.js';
import { MAX_SATELLITES, packetFlow } from './map.js';
import {
  BECKON_PERIOD_S,
  cubicBezier,
  DIVE_FOG_DEPTH,
  DIVE_STANDOFF,
  declutter,
  diveAt,
  diveFog,
  divePath,
  dragOrbit,
  homeFraming,
  homeOrbit,
  moreAngle,
  NODE_MAX_H,
  NODE_MIN_H,
  nodeHeight,
  ORBIT_R,
  orbitPosition,
  PacketField,
  type PipeFlow,
  POLAR_MAX,
  POLAR_MIN,
  packetScale,
  packetT,
  planSatellites,
  ringPositions,
  ringRadius,
  shownSatellites,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomOrbit,
} from './network.js';

const actor = (
  id: string,
  kind: 'claude' | 'subagent' | 'background' | 'terminal' = 'terminal',
  parentId: string | null = null,
) => ({
  id,
  kind,
  parentId,
});

const flows = (entries: Record<string, PipeFlow>) => new Map(Object.entries(entries));

/** Runs the field for `seconds` in 60 fps steps. */
function run(field: PacketField, seconds: number, onStep?: () => void) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    field.step(1 / 60);
    onStep?.();
  }
}

describe('the ring', () => {
  it('puts the first node at the front and goes clockwise seen from above', () => {
    const [first, second, third, fourth] = ringPositions(4);
    const r = ringRadius(4);
    expect(first?.x).toBeCloseTo(0);
    expect(first?.z).toBeCloseTo(r);
    // Seen from above (x right, z toward the viewer), clockwise from the bottom runs left.
    expect(second?.x).toBeCloseTo(-r);
    expect(third?.z).toBeCloseTo(-r);
    expect(fourth?.x).toBeCloseTo(r);
  });

  it('grows with the node count so neighbors keep their distance', () => {
    expect(ringRadius(2)).toBe(ringRadius(4));
    expect(ringRadius(20)).toBeGreaterThan(ringRadius(10));
    const nodes = ringPositions(20);
    const gap = Math.hypot(
      (nodes[0]?.x ?? 0) - (nodes[1]?.x ?? 0),
      (nodes[0]?.z ?? 0) - (nodes[1]?.z ?? 0),
    );
    expect(gap).toBeGreaterThan(2 * ORBIT_R);
  });

  it('raises a node with its activity, clamped', () => {
    expect(nodeHeight(0)).toBe(NODE_MIN_H);
    expect(nodeHeight(1)).toBe(NODE_MAX_H);
    expect(nodeHeight(4)).toBe(NODE_MAX_H);
    expect(nodeHeight(0.5)).toBeGreaterThan(NODE_MIN_H);
  });
});

describe('satellites', () => {
  it('spaces sessions and terminals evenly round the node, children round their session', () => {
    const plans = planSatellites([
      actor('s:a', 'claude'),
      actor('b:a:1', 'background', 's:a'),
      actor('t:1'),
      actor('t:2'),
    ]);
    const own = plans.filter((p) => p.parentId === null);
    expect(own.map((p) => p.angle)).toEqual([0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]);
    const child = plans.find((p) => p.actorId === 'b:a:1');
    expect(child?.parentId).toBe('s:a');
    expect(child?.radius).toBeLessThan(ORBIT_R);
  });

  it('keeps each satellite in its place when the attention order changes', () => {
    const a = [actor('t:3'), actor('s:1', 'claude'), actor('t:2')];
    const b = [actor('t:2'), actor('t:3'), actor('s:1', 'claude')];
    const angle = (plans: ReturnType<typeof planSatellites>, id: string) =>
      plans.find((p) => p.actorId === id)?.angle;
    for (const id of ['t:3', 's:1', 't:2'])
      expect(angle(planSatellites(a), id)).toBe(angle(planSatellites(b), id));
  });

  it('shows the first ones in attention order and keeps a slot for the "+N"', () => {
    const actors = Array.from({ length: MAX_SATELLITES + 3 }, (_, i) =>
      actor(`t:${String(20 - i).padStart(2, '0')}`),
    );
    const shown = shownSatellites(actors);
    expect(shown).toHaveLength(MAX_SATELLITES);
    expect(new Set(shown.map((a) => a.id))).toEqual(
      new Set(actors.slice(0, MAX_SATELLITES).map((a) => a.id)),
    );
    const plans = planSatellites(actors);
    expect(plans).toHaveLength(MAX_SATELLITES);
    const step = (2 * Math.PI) / (MAX_SATELLITES + 1);
    expect(plans[1]?.angle).toBeCloseTo(step);
    expect(moreAngle(actors)).toBeCloseTo(MAX_SATELLITES * step);
    expect(moreAngle(actors.slice(0, 3))).toBeNull();
  });

  it('circles a child round the node when its session is not shown', () => {
    const plans = planSatellites([actor('t:1'), actor('s:x:sub', 'subagent', 's:gone')]);
    expect(plans.every((p) => p.parentId === null && p.radius === ORBIT_R)).toBe(true);
  });
});

describe('packets', () => {
  it('flows out at each activity step’s rate, and not at all when quiet', () => {
    for (const step of [0, 1, 2, 3] as const) {
      const field = new PacketField();
      field.setFlows(flows({ a: { step, waiting: false } }));
      const seen = new Set<object>();
      run(field, 12, () => {
        for (const packet of field.packets) seen.add(packet);
      });
      const launched = seen.size;
      const { count, period } = packetFlow(step);
      expect(launched).toBeCloseTo(count ? (12 * count) / period : 0, -0.5);
      // In flight at once: about as many as the 2D map draws.
      expect(field.packets.length).toBeLessThanOrEqual(count);
    }
  });

  it('beckons a waiting node every 2.4 s', () => {
    const field = new PacketField();
    field.setFlows(flows({ a: { step: 0, waiting: true } }));
    let beckons = 0;
    let previous = 0;
    run(field, BECKON_PERIOD_S * 3 + 0.1, () => {
      const now = field.packets.filter((p) => p.kind === 'beckon').length;
      if (now > previous) beckons++;
      previous = now;
    });
    expect(beckons).toBe(4);
  });

  it('bursts three packets in turn, and sends a finished turn back to the core', () => {
    const field = new PacketField();
    field.setFlows(flows({ a: { step: 0, waiting: false } }));
    field.burst('a', '--orb-edit');
    field.done('a', 'ok');
    expect(field.packets.filter((p) => p.kind === 'burst')).toHaveLength(3);
    field.step(0.05);
    // The second and third wait their stagger before they set off.
    const waiting = field.packets.filter((p) => p.kind === 'burst' && p.delay > 0);
    expect(waiting).toHaveLength(2);
    expect(waiting.every((p) => packetScale(p) === 0)).toBe(true);
    const done = field.packets.find((p) => p.kind === 'done');
    expect(done && packetT(done)).toBeGreaterThan(0.9);
    run(field, 2);
    expect(field.packets).toHaveLength(0);
    expect(field.busy).toBe(false);
  });

  it('never holds more than its cap, and an event makes room in a full field', () => {
    const field = new PacketField(10);
    const all: Record<string, PipeFlow> = {};
    for (let i = 0; i < 20; i++) all[`p${i}`] = { step: 3, waiting: false };
    field.setFlows(flows(all));
    run(field, 3, () => expect(field.packets.length).toBeLessThanOrEqual(10));
    expect(field.packets).toHaveLength(10);
    field.burst('p0', '--orb-read');
    expect(field.packets).toHaveLength(10);
    expect(field.packets.filter((p) => p.kind === 'burst')).toHaveLength(3);
  });

  it('drops the packets of a pipeline that is gone', () => {
    const field = new PacketField();
    field.setFlows(flows({ a: { step: 3, waiting: false }, b: { step: 3, waiting: false } }));
    run(field, 1);
    field.setFlows(flows({ b: { step: 3, waiting: false } }));
    expect(field.packets.every((p) => p.pipe === 'b')).toBe(true);
  });
});

describe('the camera', () => {
  it('clamps the tilt on a drag and the zoom round its home distance', () => {
    const home = homeOrbit(50);
    expect(dragOrbit(home, 0, -10_000).polar).toBe(POLAR_MAX);
    expect(dragOrbit(home, 0, 10_000).polar).toBe(POLAR_MIN);
    expect(dragOrbit(home, 100, 0).azimuth).toBeLessThan(0);
    expect(zoomOrbit(home, 100, 50).distance).toBe(50 * ZOOM_MAX);
    expect(zoomOrbit(home, 0.001, 50).distance).toBe(50 * ZOOM_MIN);
  });

  it('frames every node and its label inside the stage, centered', () => {
    const target = { x: 0, y: 1.4, z: 0 };
    const few = homeFraming(3, 1200, 700, 38, target);
    const many = homeFraming(10, 1200, 700, 38, target);
    expect(many.distance).toBeGreaterThan(few.distance);
    // A shorter stage needs the camera further back for the same ring.
    expect(homeFraming(10, 1200, 450, 38, target).distance).toBeGreaterThan(many.distance);
    expect(Math.abs(many.shift)).toBeLessThan(0.5);
    // The camera sits above the floor, looking down at the ring.
    const eye = orbitPosition(homeOrbit(many.distance), target);
    expect(eye.y).toBeGreaterThan(target.y);
    expect(eye.z).toBeGreaterThan(ringRadius(10));
  });
});

describe('labels', () => {
  const box = (x: number, y: number) => ({ x, y, width: 200, height: 70 });

  const ys = (places: { y: number }[]) => places.map((p) => p.y);

  it('leaves labels that are clear of each other where they are', () => {
    const places = declutter([box(100, 400), box(400, 380), box(700, 300)]);
    expect(ys(places)).toEqual([400, 380, 300]);
    expect(places.some((p) => p.crowded)).toBe(false);
  });

  it('lifts a farther label above a nearer one it would cover', () => {
    const [near, far] = ys(declutter([box(300, 400), box(350, 380)]));
    expect(near).toBe(400);
    expect(far).toBe(400 - 70 - 8);
  });

  it('keeps lifting past every label it runs into, but not off the top', () => {
    const [, , third] = ys(declutter([box(300, 400), box(320, 322), box(340, 390)]));
    expect(third).toBe(322 - 70 - 8);
    const [, high] = ys(declutter([box(300, 300), box(900, 40)], 8));
    expect(high).toBe(8 + 70);
  });

  it('crowds out a label that would still overlap at the top, instead of piling it up', () => {
    const [first, second, third] = declutter([box(300, 160), box(320, 150), box(340, 140)], 8);
    expect(first).toEqual({ y: 160, compact: false, crowded: false });
    // 160 − 78 = 82 ≥ 78: the second just fits above the first.
    expect(second).toEqual({ y: 82, compact: false, crowded: false });
    // No room left above the second: it stays at its node, and nobody makes way for it.
    expect(third).toEqual({ y: 140, compact: false, crowded: true });
  });

  it('falls back to the compact form where only that fits', () => {
    const compact = { width: 120, height: 30 };
    // Two cards 336 px apart leave 136 px between them: room for a 120 px chip, not a card.
    const places = declutter(
      [box(300, 140), box(636, 140), { ...box(468, 120), compact }, { ...box(468, 110), compact }],
      60,
    );
    expect(places[2]).toEqual({ y: 120, compact: true, crowded: false });
    // The next one finds the chip in its way and no room above it (the top is at 60): crowded out.
    expect(places[3]?.crowded).toBe(true);
  });
});

describe('the dive', () => {
  const node = ringPositions(6)[1] ?? { x: 0, y: 0, z: 0 };
  const eye = orbitPosition(homeOrbit(60), { x: 0, y: 1.4, z: 0 });
  const look = { x: 0, y: 1.4, z: 0 };
  const path = divePath(eye, look, node, 2.4);
  const dist = (a: { x: number; y: number; z: number }, b: typeof a) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  it('starts where the camera is and ends short of the node, on its pipeline', () => {
    const start = diveAt(path, 0);
    expect(start.position).toEqual(eye);
    expect(start.look).toEqual(look);
    const end = diveAt(path, 1);
    expect(Math.hypot(end.position.x - node.x, end.position.z - node.z)).toBeCloseTo(
      DIVE_STANDOFF,
      6,
    );
    // On the line from the core to the node: inside the ring, facing out.
    const along = (end.position.x * node.x + end.position.z * node.z) / Math.hypot(node.x, node.z);
    expect(along).toBeCloseTo(Math.hypot(node.x, node.z) - DIVE_STANDOFF, 6);
    expect(end.look.x).toBe(node.x);
    expect(end.look.z).toBe(node.z);
    // Above the monolith's top, looking down at it.
    expect(end.position.y).toBeGreaterThan(2.4);
    expect(end.look.y).toBeLessThan(end.position.y);
  });

  it('flies over the core, then closes in on the node without overshooting', () => {
    const samples = Array.from({ length: 21 }, (_, i) => diveAt(path, i / 20).position);
    const toNode = samples.map((p) => dist(p, { ...node, y: p.y }));
    for (let i = 10; i < toNode.length; i++) {
      expect(toNode[i]).toBeLessThanOrEqual((toNode[i - 1] ?? 0) + 1e-9);
    }
    // Every point stays above the floor.
    for (const p of samples) expect(p.y).toBeGreaterThan(0.5);
    // The gaze has settled on the node before the end of the flight.
    expect(diveAt(path, 0.75).look).toEqual(diveAt(path, 1).look);
  });

  it('pulls the fog in to just past the node', () => {
    const home = { near: 70, far: 190 };
    expect(diveFog(0, home)).toEqual(home);
    const fog = diveFog(1, home);
    expect(fog.near).toBeCloseTo(DIVE_STANDOFF, 6);
    expect(fog.far).toBeCloseTo(DIVE_STANDOFF + DIVE_FOG_DEPTH, 6);
    // Every other node in front of the camera lies beyond the fog wall (the rest are out of view).
    const end = diveAt(path, 1);
    const ahead = { x: end.look.x - end.position.x, z: end.look.z - end.position.z };
    const others = ringPositions(6).filter((_, i) => i !== 1);
    for (const count of [6, 12]) {
      const ring = ringPositions(count);
      const target = ring[1] ?? node;
      const far = divePath(eye, look, target, 2.4);
      const there = diveAt(far, 1);
      const forward = { x: there.look.x - there.position.x, z: there.look.z - there.position.z };
      for (const other of ring.filter((_, i) => i !== 1)) {
        const to = { x: other.x - there.position.x, z: other.z - there.position.z };
        const cos =
          (to.x * forward.x + to.z * forward.z) /
          (Math.hypot(to.x, to.z) * Math.hypot(forward.x, forward.z));
        if (cos < Math.cos((40 * Math.PI) / 180)) continue;
        expect(Math.hypot(to.x, to.z)).toBeGreaterThan(fog.far);
      }
    }
    expect(others.length).toBe(5);
    expect(Math.hypot(ahead.x, ahead.z)).toBeGreaterThan(0);
  });

  it('eases like ease.inOut', () => {
    const inOut = cubicBezier(...ease.inOut);
    expect(inOut(0)).toBe(0);
    expect(inOut(1)).toBe(1);
    expect(inOut(0.5)).toBeCloseTo(0.5, 4);
    expect(inOut(0.1)).toBeLessThan(0.05);
    expect(inOut(0.9)).toBeGreaterThan(0.95);
    let last = 0;
    for (let i = 1; i <= 50; i++) {
      const v = inOut(i / 50);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

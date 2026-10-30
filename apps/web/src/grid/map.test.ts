import { describe, expect, it } from 'vitest';
import type { SceneActor } from '../layouts/scene.js';
import { loop } from '../motion.js';
import {
  boardEnergy,
  burstColor,
  CORE_R,
  cardsOverlap,
  hexCenter,
  keepOrder,
  NODE_H,
  NODE_W,
  nodeCaption,
  nodeCounts,
  packetFlow,
  planCockpit,
  planMap,
  segment,
} from './map.js';

function actor(id: string, overrides: Partial<SceneActor> = {}): SceneActor {
  return {
    id,
    kind: 'terminal',
    projectId: 'p1',
    parentId: null,
    state: 'idle',
    token: 'quiet',
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

describe('planMap', () => {
  it('puts the first node at the top, the core in the middle, and goes clockwise', () => {
    const plan = planMap(4, 1200);
    expect(plan.core.x).toBe(600);
    const [top, right, bottom, left] = plan.nodes;
    expect(top?.x).toBeCloseTo(600, 0);
    expect(top?.y).toBeLessThan(plan.core.y);
    expect(right?.x).toBeGreaterThan(plan.core.x);
    expect(bottom?.y).toBeGreaterThan(plan.core.y);
    expect(left?.x).toBeLessThan(plan.core.x);
  });

  it.each([
    [1, 900],
    [5, 900],
    [10, 1100],
    [10, 1500],
    [16, 1200],
    [24, 900],
  ])('keeps %i labels apart and on the stage at %i px', (count, width) => {
    const plan = planMap(count, width);
    expect(plan.nodes).toHaveLength(count);
    for (const [i, a] of plan.nodes.entries()) {
      expect(a.x - NODE_W / 2).toBeGreaterThanOrEqual(0);
      expect(a.x + NODE_W / 2).toBeLessThanOrEqual(width);
      expect(a.y - NODE_H / 2).toBeGreaterThanOrEqual(0);
      expect(a.y + NODE_H / 2).toBeLessThanOrEqual(plan.height);
      for (const b of plan.nodes.slice(i + 1)) expect(cardsOverlap(a, b)).toBe(false);
      // No label sits on the core.
      expect(
        Math.abs(a.x - plan.core.x) >= NODE_W / 2 + CORE_R ||
          Math.abs(a.y - plan.core.y) >= NODE_H / 2 + CORE_R,
      ).toBe(true);
    }
  });

  it('grows taller with more projects instead of crowding them', () => {
    expect(planMap(16, 1100).height).toBeGreaterThan(planMap(4, 1100).height);
    expect(planMap(0, 1100).nodes).toEqual([]);
  });
});

describe('segment', () => {
  it('trims both ends and points from the core to the node', () => {
    const run = segment({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20);
    expect(run).toEqual({ x: 10, y: 0, angle: 0, length: 70 });
    expect(segment({ x: 0, y: 0 }, { x: 0, y: 50 }, 0, 0).angle).toBe(90);
    expect(segment({ x: 0, y: 0 }, { x: 0, y: 5 }, 10, 10).length).toBe(0);
  });

  it('starts at the hexagon inside the card', () => {
    expect(hexCenter({ x: 200, y: 100 })).toEqual({
      x: 200 - NODE_W / 2 + 30,
      y: 100 - NODE_H / 2 + 30,
    });
  });
});

describe('packetFlow', () => {
  it('sends more packets, faster, as activity rises', () => {
    expect(packetFlow(0).count).toBe(0);
    const rates = ([1, 2, 3] as const).map((step) => {
      const flow = packetFlow(step);
      return flow.count / flow.period;
    });
    expect(rates[0]).toBeLessThan(rates[1] ?? 0);
    expect(rates[1]).toBeLessThan(rates[2] ?? 0);
    expect(packetFlow(3).period).toBe(loop.packetPeak);
  });

  it('never repeats faster than 3 times a second on one pipeline (WCAG 2.3.1)', () => {
    for (const step of [1, 2, 3] as const) {
      const flow = packetFlow(step);
      expect(flow.count / flow.period).toBeLessThan(3);
    }
  });
});

describe('burstColor', () => {
  it('takes the tool family color, or the neon', () => {
    expect(burstColor('Bash')).toBe('var(--st-tool)');
    expect(burstColor('Edit')).toBe('var(--orb-edit)');
    expect(burstColor(null)).toBe('var(--grid-neon)');
  });
});

describe('node text', () => {
  it('captions with the busiest actor, else the summary', () => {
    const busy = actor('a', { caption: { glyph: '▶', text: 'pnpm test', tone: 'active' } });
    expect(nodeCaption({ actors: [actor('b'), busy], summary: 'Done' }).text).toBe('pnpm test');
    expect(nodeCaption({ actors: [actor('b')], summary: 'Done' }).text).toBe('Done');
    expect(nodeCaption({ actors: [], summary: null }).text).toBe('Nothing running');
  });

  it('counts sessions, terminals and background work', () => {
    expect(
      nodeCounts([
        { kind: 'claude' },
        { kind: 'terminal' },
        { kind: 'terminal' },
        { kind: 'subagent' },
      ]),
    ).toBe('1 Claude · 2 terminals · 1 in background');
    expect(nodeCounts([])).toBe('Nothing running');
  });

  it('measures the board energy, capped at 1', () => {
    expect(boardEnergy([])).toBe(0);
    expect(boardEnergy([{ activity: 0.4, actors: [actor('a', { activity: 0.6 })] }])).toBe(0.3);
    expect(boardEnergy([1, 1, 1].map((activity) => ({ activity, actors: [] })))).toBe(1);
  });
});

describe('planCockpit', () => {
  it('centers the main session and spreads the rest right, left, right', () => {
    const claude = actor('s:1', { kind: 'claude' });
    const sub = actor('b:1', { kind: 'subagent', parentId: 's:1' });
    const t1 = actor('t:1');
    const t2 = actor('t:2');
    const t3 = actor('t:3');
    const plan = planCockpit([t1, claude, sub, t2, t3]);
    expect(plan.center?.id).toBe('s:1');
    expect(plan.right.map((a) => a.id)).toEqual(['t:1', 't:3']);
    expect(plan.left.map((a) => a.id)).toEqual(['t:2']);
    expect(plan.children.get('s:1')?.map((a) => a.id)).toEqual(['b:1']);
  });

  it('centers a terminal when there is no session', () => {
    expect(planCockpit([actor('t:1'), actor('t:2')]).center?.id).toBe('t:1');
    expect(planCockpit([]).center).toBeNull();
  });
  it('keeps a screen in its column when the scene re-sorts the actors', () => {
    const claude = actor('s:1', { kind: 'claude' });
    const [t1, t2, t3] = [actor('t:1'), actor('t:2'), actor('t:3')];
    const before = keepOrder([claude, t1, t2, t3], []);
    // t:3 finished its command and now ranks first.
    const after = planCockpit(
      keepOrder(
        [t3, claude, t1, t2],
        before.map((a) => a.id),
      ),
    );
    expect(after.right.map((a) => a.id)).toEqual(['t:1', 't:3']);
    expect(after.left.map((a) => a.id)).toEqual(['t:2']);
  });
});

describe('keepOrder', () => {
  it('keeps known actors in their first order, newcomers after, leavers dropped', () => {
    const ids = keepOrder([actor('c'), actor('a'), actor('d')], ['a', 'b', 'c']).map((a) => a.id);
    expect(ids).toEqual(['a', 'c', 'd']);
    expect(keepOrder([actor('b'), actor('a')], []).map((a) => a.id)).toEqual(['b', 'a']);
  });
});

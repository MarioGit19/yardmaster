import { describe, expect, it } from 'vitest';
import type { SceneActor } from '../layouts/scene.js';
import {
  buildingColumns,
  CHARACTER_PX,
  LONG_RUN_MS,
  MAX_CHARACTERS,
  planRoom,
  READ_TRIP_MS,
  walkSeconds,
} from './room.js';

const NOW = 1_760_000_000_000;
const WIDTH = 380;

function actor(id: string, over: Partial<SceneActor> = {}): SceneActor {
  return {
    id,
    kind: 'terminal',
    projectId: 'p-acme',
    parentId: null,
    state: 'idle',
    tone: 'idle',
    activity: 0,
    label: id,
    caption: { glyph: null, text: 'Idle', tone: 'rest' },
    name: `acme-shop, ${id}, idle`,
    links: { href: '/', sessionId: null, terminalId: null, approvalId: null },
    since: NOW - 60_000,
    tool: null,
    toolSince: null,
    planning: false,
    ports: [],
    runningSince: null,
    exit: null,
    ...over,
  };
}

const claude = (id: string, over: Partial<SceneActor> = {}) =>
  actor(id, { kind: 'claude', state: 'idle', ...over });

const plan = (actors: SceneActor[], previous?: Map<string, 'bench' | 'rack'>) =>
  planRoom(actors, { width: WIDTH, now: NOW, previous });

const placement = (p: ReturnType<typeof plan>, id: string) =>
  p.placements.find((x) => x.actorId === id);

describe('planRoom', () => {
  it('gives each session a desk and each command a bench or rack, idle shells the couch', () => {
    const p = plan([
      claude('s:a', { state: 'typing' }),
      actor('t:dev', { state: 'serving', ports: [3000] }),
      actor('t:test', { state: 'running', runningSince: NOW - 2_000 }),
      actor('t:zsh'),
    ]);
    expect(p.stations.map((s) => s.key)).toEqual([
      'desk:s:a',
      'rack:t:dev',
      'bench:t:test',
      'couch:0',
    ]);
    expect(placement(p, 's:a')?.at).toBe('desk:s:a');
    expect(placement(p, 't:dev')?.at).toBe('rack:t:dev');
    expect(placement(p, 't:test')?.at).toBe('bench:t:test');
    expect(placement(p, 't:zsh')?.at).toBe('couch:0');
    // The bookshelf goes before anyone does.
    expect(p.hidden).toBe(0);
    expect(plan([claude('s:a'), actor('t:zsh')]).stations.at(-1)?.key).toBe('bookshelf');
  });

  it('moves a command running past 30 s to a rack, and remembers it there', () => {
    const long = actor('t:build', { state: 'running', runningSince: NOW - LONG_RUN_MS });
    const p = plan([long]);
    expect(placement(p, 't:build')?.at).toBe('rack:t:build');
    // It finishes: done plays where it ran, then idle walks to the couch.
    const done = plan([actor('t:build', { state: 'done' })], p.work);
    expect(placement(done, 't:build')?.at).toBe('rack:t:build');
    expect(placement(plan([actor('t:build')], done.work), 't:build')?.at).toBe('couch:0');
  });

  it('keeps a failed command at its bench', () => {
    const run = plan([actor('t:test', { state: 'running', runningSince: NOW })]);
    const failed = plan([actor('t:test', { state: 'error', exit: 1 })], run.work);
    expect(placement(failed, 't:test')?.at).toBe('bench:t:test');
  });

  it('sends a long read to the bookshelf and a planning session to the whiteboard', () => {
    const reading = claude('s:a', {
      state: 'reading',
      tool: 'Read',
      toolSince: NOW - READ_TRIP_MS,
    });
    const quick = claude('s:b', { state: 'reading', tool: 'Grep', toolSince: NOW - 500 });
    const p = plan([reading, quick]);
    expect(placement(p, 's:a')).toMatchObject({ at: 'bookshelf', front: true });
    expect(placement(p, 's:b')?.at).toBe('desk:s:b');
    // The desk stays while its session is away.
    expect(p.stations.some((s) => s.key === 'desk:s:a')).toBe(true);

    const planning = plan([claude('s:a', { state: 'typing', planning: true })]);
    expect(placement(planning, 's:a')).toMatchObject({ at: 'whiteboard', front: true });
    // Waiting wins: it stays at the desk with its hand up.
    const waiting = plan([claude('s:a', { state: 'waiting', planning: true })]);
    expect(placement(waiting, 's:a')?.at).toBe('desk:s:a');
  });

  it('seats subagents at one side desk as mini crew', () => {
    const p = plan([
      claude('s:a', { state: 'delegating' }),
      actor('b:1', { kind: 'subagent', state: 'thinking', parentId: 's:a' }),
      actor('b:2', { kind: 'background', state: 'running', parentId: 's:a' }),
    ]);
    expect(p.stations.filter((s) => s.kind === 'side-desk')).toHaveLength(1);
    const minis = p.placements.filter((x) => x.at === 'side-desk');
    expect(minis).toHaveLength(2);
    expect(minis[0]?.size).toBeLessThan(CHARACTER_PX);
    expect(minis[1]?.x).toBeGreaterThan(minis[0]?.x ?? 0);
  });

  it('draws at most 8 and counts the rest, least urgent first', () => {
    const shells = Array.from({ length: 12 }, (_, i) => actor(`t:${i}`, { since: NOW - i }));
    const p = plan(shells);
    expect(p.placements.length).toBeLessThanOrEqual(MAX_CHARACTERS);
    expect(p.hidden).toBe(12 - p.placements.length);
    // Scene order is attention first: the first actors are the ones drawn.
    expect(p.placements.map((x) => x.actorId)).toContain('t:0');
    expect(p.placements.map((x) => x.actorId)).not.toContain('t:11');
  });

  it('keeps every station inside the room and characters apart', () => {
    const p = plan([
      claude('s:a', { state: 'typing' }),
      claude('s:b', { state: 'thinking', since: NOW - 10 }),
      actor('t:dev', { state: 'serving' }),
      actor('t:test', { state: 'running', runningSince: NOW }),
      actor('t:zsh'),
      actor('t:zsh2'),
    ]);
    for (const station of p.stations) expect(station.x + station.w).toBeLessThanOrEqual(WIDTH);
    const row = p.placements.filter((x) => !x.front).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const gap = (row[i]?.x ?? 0) - (row[i - 1]?.x ?? 0);
      expect(gap).toBeGreaterThanOrEqual(26);
    }
  });

  it('keeps the furniture order stable when attention reorders the actors', () => {
    const a = claude('s:a', { since: NOW - 100 });
    const b = claude('s:b', { since: NOW - 50 });
    const keys = (actors: SceneActor[]) => plan(actors).stations.map((s) => s.key);
    expect(keys([a, b])).toEqual(keys([b, a]));
  });
});

describe('buildingColumns', () => {
  it('fits one room on a phone and 3–5 on desktops', () => {
    expect(buildingColumns(320).columns).toBe(1);
    expect(buildingColumns(1150).columns).toBe(3);
    expect(buildingColumns(1600).columns).toBe(4);
    expect(buildingColumns(4000).columns).toBe(5);
  });
});

describe('walkSeconds', () => {
  it('takes 600–900 ms with the distance', () => {
    expect(walkSeconds(0)).toBeCloseTo(0.6);
    expect(walkSeconds(120)).toBeGreaterThan(0.6);
    expect(walkSeconds(1000)).toBeCloseTo(0.9);
  });
});

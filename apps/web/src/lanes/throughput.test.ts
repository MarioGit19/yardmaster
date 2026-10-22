import { type BoardState, type Execution, emptyBoardState } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { sparkLevel, sparkPoints } from './spark.js';
import {
  backfill,
  bytesByTerminal,
  rateLevel,
  SAMPLE_MS,
  SAMPLES,
  SampleRing,
  ThroughputSampler,
} from './throughput.js';

const NOW = 1_760_000_000_000;

function exec(id: string, terminalId: string, over: Partial<Execution> = {}): Execution {
  return {
    id,
    terminalId,
    commandLine: 'pnpm dev',
    confidence: 'high',
    cwd: null,
    startedAt: NOW - 10_000,
    endedAt: null,
    exitCode: null,
    outputBytes: 0,
    truncated: false,
    interactive: false,
    ...over,
  };
}

function board(...executions: Execution[]): BoardState {
  const state = emptyBoardState();
  for (const e of executions) state.executions[e.id] = e;
  return state;
}

const newest = (ring: SampleRing, count = 1) =>
  Array.from({ length: count }, (_, i) => ring.at(SAMPLES - count + i));

describe('SampleRing', () => {
  it('reads oldest first and drops the oldest on push', () => {
    const ring = new SampleRing();
    for (let i = 1; i <= SAMPLES + 2; i++) ring.push(i);
    expect(ring.at(0)).toBe(3);
    expect(ring.at(SAMPLES - 1)).toBe(SAMPLES + 2);
    expect(ring.max()).toBe(SAMPLES + 2);
  });

  it('knows whether output arrived recently', () => {
    const ring = new SampleRing();
    ring.push(10);
    ring.push(0);
    expect(ring.recent(2)).toBe(true);
    ring.push(0);
    expect(ring.recent(2)).toBe(false);
  });
});

describe('backfill', () => {
  it('spreads an execution evenly over its run inside the window', () => {
    const state = board(exec('e1', 't1', { startedAt: NOW - 10_000, outputBytes: 10_000 }));
    const ring = backfill(state, 't1', NOW);
    expect(newest(ring, 10)).toEqual(Array(10).fill(1_000));
    expect(ring.at(SAMPLES - 11)).toBe(0);
  });

  it('ignores other terminals and executions that ended before the window', () => {
    const state = board(
      exec('e1', 't2', { outputBytes: 5_000 }),
      exec('e2', 't1', {
        startedAt: NOW - 200_000,
        endedAt: NOW - 100_000,
        outputBytes: 9_000,
      }),
    );
    expect(backfill(state, 't1', NOW).max()).toBe(0);
  });
});

describe('ThroughputSampler', () => {
  function setup(initial: BoardState) {
    let current = initial;
    const timers: Array<() => void> = [];
    const sampler = new ThroughputSampler({
      getBoard: () => current,
      now: () => NOW,
      setInterval: (cb) => timers.push(cb),
      clearInterval: () => timers.splice(0),
    });
    return { sampler, timers, set: (b: BoardState) => (current = b) };
  }

  it('records byte deltas per sample and stops the timer with the last watcher', () => {
    const { sampler, timers, set } = setup(board(exec('e1', 't1', { outputBytes: 500 })));
    const seen: number[] = [];
    const stop = sampler.watch('t1', (ring) => seen.push(ring.at(SAMPLES - 1)));
    expect(timers).toHaveLength(1);

    set(board(exec('e1', 't1', { outputBytes: 1_700 })));
    sampler.sample();
    set(board(exec('e1', 't1', { outputBytes: 1_700 }), exec('e2', 't1', { outputBytes: 300 })));
    sampler.sample();
    // Pruned executions shrink the counter: that sample counts as quiet.
    set(board());
    sampler.sample();
    expect(seen.slice(1)).toEqual([1_200, 300, 0]);

    stop();
    expect(timers).toHaveLength(0);
    expect(sampler.size).toBe(0);
  });

  it('shares one ring between watchers of a terminal', () => {
    const { sampler } = setup(board());
    const rings = new Set<SampleRing>();
    const a = sampler.watch('t1', (r) => rings.add(r));
    const b = sampler.watch('t1', (r) => rings.add(r));
    expect(rings.size).toBe(1);
    a();
    expect(sampler.size).toBe(1);
    b();
    expect(sampler.size).toBe(0);
  });

  it('sums bytes per terminal', () => {
    const totals = bytesByTerminal(
      board(exec('a', 't1', { outputBytes: 2 }), exec('b', 't1', { outputBytes: 3 })),
    );
    expect(totals.get('t1')).toBe(5);
  });
});

describe('rateLevel', () => {
  it('buckets the recent output rate', () => {
    const ring = new SampleRing();
    expect(rateLevel(ring)).toBe(0);
    ring.push(100);
    expect(rateLevel(ring)).toBe(1);
    ring.push((2_000 * SAMPLE_MS) / 1000);
    expect(rateLevel(ring)).toBe(2);
    ring.push(20_000);
    expect(rateLevel(ring)).toBe(3);
    ring.push(0);
    ring.push(0);
    expect(rateLevel(ring)).toBe(0);
  });
});

describe('sparkline geometry', () => {
  it('keeps a trickle low and never clips a burst', () => {
    expect(sparkLevel(0, 0)).toBe(0);
    expect(sparkLevel(60, 60)).toBeLessThan(0.35);
    expect(sparkLevel(1e9, 1e9)).toBe(1);
  });

  it('places the newest sample one step past the visible width', () => {
    const ring = new SampleRing();
    ring.push(4_096);
    const points = sparkPoints(ring, 58, 20, 1);
    expect(points).toHaveLength(SAMPLES);
    expect(points[0]).toEqual([0, 19]);
    const last = points.at(-1) ?? [0, 0];
    expect(last[0]).toBeCloseTo(59);
    expect(last[1]).toBeCloseTo(1);
  });
});

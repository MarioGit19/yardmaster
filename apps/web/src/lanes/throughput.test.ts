import { type BoardState, type Execution, emptyBoardState } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { makeTerminal } from '../test/board.js';
import {
  CPU_MIN_SAMPLES,
  CPU_SHOWN,
  CPU_VARIES,
  CPU_WINDOW_MS,
  cpuPoints,
  cpuVaries,
  laneSignal,
  OUTPUT_TOP,
  OUTPUT_WINDOW_MS,
  outputLevel,
  outputTicks,
  sameSignal,
  windowLabel,
} from './spark.js';
import {
  backfill,
  bytesByTerminal,
  CPU_SAMPLE_EVERY,
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

  it('samples the CPU once per five output samples', () => {
    const state = board();
    const terminal = makeTerminal('t1', 'p1');
    const stats = { pid: 1, cpu: 40, rssBytes: 0, processCount: 1, sampledAt: NOW };
    state.terminals.t1 = { ...terminal, stats };
    const { sampler } = setup(state);
    let cpu = new SampleRing();
    sampler.watch('t1', (_ring, c) => {
      cpu = c;
    });
    expect(cpu.filled).toBe(1);
    for (let i = 0; i < CPU_SAMPLE_EVERY - 1; i++) sampler.sample();
    expect(cpu.filled).toBe(1);
    sampler.sample();
    expect(cpu.filled).toBe(2);
    expect(cpu.at(SAMPLES - 1)).toBe(40);
  });

  it('sums bytes per terminal', () => {
    const totals = bytesByTerminal(
      board(exec('a', 't1', { outputBytes: 2 }), exec('b', 't1', { outputBytes: 3 })),
    );
    expect(totals.get('t1')).toBe(5);
  });
});

const series = (...values: number[]) => {
  const ring = new SampleRing();
  for (const value of values) ring.push(value);
  return ring;
};
const silent = () => series(...Array(SAMPLES).fill(0));

describe('laneSignal', () => {
  it('draws a CPU line only past the threshold, with enough samples', () => {
    const base = Array(CPU_MIN_SAMPLES - 1).fill(20);
    expect(cpuVaries(series(...base, 20 + CPU_VARIES - 0.1))).toBe(false);
    expect(cpuVaries(series(...base, 20 + CPU_VARIES))).toBe(true);
    expect(cpuVaries(series(...Array(CPU_MIN_SAMPLES - 2).fill(5), 90))).toBe(false);
  });

  it('measures variation on the 0–100 axis, so multi-core swings above it stay text', () => {
    const multicore = series(...Array(CPU_MIN_SAMPLES).fill(180), 400, 250);
    expect(cpuVaries(multicore)).toBe(false);
    expect(laneSignal(silent(), multicore, true)).toEqual({ kind: 'value', cpu: 250 });
  });

  it('ignores the unfilled start of the window', () => {
    // A real ring holds zeros past its filled samples; they must not count as a swing.
    expect(cpuVaries(series(...Array(CPU_MIN_SAMPLES).fill(50)))).toBe(false);
  });

  it('prefers the line, then output ticks, then the value, then nothing', () => {
    const output = series(...Array(SAMPLES - 1).fill(0), 500);
    const moving = series(...Array(CPU_MIN_SAMPLES).fill(5), 60, 22);
    const flat = series(30, 31, 30, 30, 31, 30);
    expect(laneSignal(output, moving, true)).toEqual({ kind: 'line', cpu: 22 });
    expect(laneSignal(output, flat, true)).toEqual({ kind: 'ticks' });
    expect(laneSignal(silent(), flat, true)).toEqual({ kind: 'value', cpu: 30 });
    expect(laneSignal(silent(), flat, false)).toEqual({ kind: 'none' });
    expect(laneSignal(silent(), series(0.4, 0.5, 0.3), true)).toEqual({ kind: 'none' });
  });

  it("doesn't blink as the CPU crosses the idle mark", () => {
    const hovering = series(CPU_SHOWN, CPU_SHOWN - 1, CPU_SHOWN - 1);
    expect(laneSignal(silent(), hovering, true).kind).toBe('value');
    const settled = series(CPU_SHOWN - 1, CPU_SHOWN - 1, CPU_SHOWN - 1);
    expect(laneSignal(silent(), settled, true).kind).toBe('none');
  });

  it('compares signals by kind and value', () => {
    expect(sameSignal({ kind: 'value', cpu: 3 }, { kind: 'value', cpu: 3 })).toBe(true);
    expect(sameSignal({ kind: 'value', cpu: 3 }, { kind: 'value', cpu: 4 })).toBe(false);
    expect(sameSignal({ kind: 'none' }, { kind: 'ticks' })).toBe(false);
  });

  it('labels the fixed windows', () => {
    expect(windowLabel(CPU_WINDOW_MS)).toBe('5m');
    expect(windowLabel(OUTPUT_WINDOW_MS)).toBe('1m');
  });
});

describe('graph geometry', () => {
  it('keeps a trickle low and never clips a burst', () => {
    expect(outputLevel(0)).toBe(0);
    expect(outputLevel(60)).toBeLessThan(0.35);
    expect(outputLevel(OUTPUT_TOP)).toBeCloseTo(1);
    expect(outputLevel(1e9)).toBe(1);
  });

  it('plots the CPU on a fixed axis, whatever the rest of the window did', () => {
    const points = cpuPoints(series(10, 20, 500), 58, 22, 1);
    expect(points).toHaveLength(3);
    // 10 % of a 20 px span above the bottom inset.
    expect(points[0]?.[1]).toBeCloseTo(19);
    expect(points[2]?.[1]).toBeCloseTo(1);
    const alone = cpuPoints(series(10, 12, 11), 58, 22, 1);
    expect(alone[0]?.[1]).toBeCloseTo(19);
  });

  it('places the newest sample one step past the visible width', () => {
    const last = cpuPoints(series(50), 58, 20, 1).at(-1) ?? [0, 0];
    expect(last[0]).toBeCloseTo(59);
  });

  it('draws one tick per sample with output, taller for more', () => {
    const ticks = outputTicks(series(...Array(SAMPLES - 3).fill(0), 100, 0, 50_000), 58, 20);
    expect(ticks).toHaveLength(2);
    expect(ticks[1]?.x).toBeCloseTo(59);
    expect(ticks[1]?.height ?? 0).toBeGreaterThan(ticks[0]?.height ?? 0);
  });
});

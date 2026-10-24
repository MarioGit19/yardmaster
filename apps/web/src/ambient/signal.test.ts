import type { Approval, Execution } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { makeSession, sampleBoard } from '../test/board.js';
import {
  ATTENTION_POINT_MAX_AGE_MS,
  AttentionPoint,
  activeSessionCount,
  approach,
  attentionProjectId,
  boardActivity,
  DEFAULT_ATTENTION_POINT,
  energyFrom,
  frameDue,
  REORDER_SETTLE_MS,
  runningExecutionCount,
  ThroughputMeter,
  totalOutputBytes,
  viewportPoint,
} from './signal.js';

const T0 = 1_760_000_000_000;

function makeExecution(id: string, outputBytes: number, endedAt: number | null = null): Execution {
  return {
    id,
    terminalId: 't-1',
    commandLine: 'pnpm dev',
    confidence: 'high',
    cwd: null,
    startedAt: T0,
    endedAt,
    exitCode: endedAt === null ? null : 0,
    outputBytes,
    truncated: false,
    interactive: false,
  };
}

function makeApproval(id: string, sessionId: string, createdAt: number): Approval {
  return {
    id,
    sessionId,
    source: 'sdk',
    tool: 'Bash',
    input: {},
    toolUseId: null,
    createdAt,
    expiresAt: null,
    state: 'pending',
    decidedAt: null,
    reason: null,
  };
}

describe('board signals', () => {
  it('counts working, tool and compacting sessions as active', () => {
    const board = sampleBoard();
    board.sessions['s-3'] = makeSession('s-3', 'p-zen', {
      kind: 'tool',
      tool: 'Edit',
      toolUseId: null,
    });
    board.sessions['s-4'] = makeSession('s-4', 'p-zen', {
      kind: 'compacting',
      previous: { kind: 'working' },
    });
    board.sessions['s-5'] = makeSession('s-5', 'p-zen', { kind: 'idle' });
    expect(activeSessionCount(board)).toBe(3);
  });

  it('counts running executions and sums output bytes', () => {
    const board = sampleBoard();
    board.executions['e-1'] = makeExecution('e-1', 2048);
    board.executions['e-2'] = makeExecution('e-2', 512, T0 + 10);
    expect(runningExecutionCount(board)).toBe(1);
    expect(totalOutputBytes(board)).toBe(2560);
  });

  it('turns toward the oldest pending approval first', () => {
    const board = sampleBoard();
    board.approvals['a-new'] = makeApproval('a-new', 's-1', T0 + 50);
    board.approvals['a-old'] = makeApproval('a-old', 's-2', T0 + 10);
    expect(attentionProjectId(board)).toBe('p-orbit');
  });

  it('ignores decided approvals and falls back to waiting sessions', () => {
    const board = sampleBoard();
    board.approvals['a-1'] = { ...makeApproval('a-1', 's-2', T0), state: 'allowed' };
    expect(attentionProjectId(board)).toBe('p-acme');
  });

  it('picks the session that has waited longest', () => {
    const board = sampleBoard();
    board.sessions['s-9'] = {
      ...makeSession('s-9', 'p-zen', { kind: 'waiting_input' }),
      updatedAt: T0 - 1000,
    };
    expect(attentionProjectId(board)).toBe('p-zen');
  });

  it('has no attention target when nothing waits', () => {
    const board = sampleBoard();
    delete board.sessions['s-1'];
    expect(attentionProjectId(board)).toBeNull();
  });
});

describe('boardActivity', () => {
  it("adds up the projects' activity levels, ignoring other entities", () => {
    const board = sampleBoard();
    const now = T0;
    const pulse = (energy: number) => ({ energy, at: now, lastAt: now, events: 1, doneAt: null });
    expect(boardActivity(board, {}, now)).toBe(0);
    const busy = boardActivity(board, { 'p:p-acme': pulse(10), 'p:p-zen': pulse(10) }, now);
    expect(busy).toBeCloseTo(2, 3);
    // Sessions and terminals have their own pulses; only projects count.
    expect(boardActivity(board, { 's:s-1': pulse(10), 't:t-1': pulse(10) }, now)).toBe(0);
    // Levels decay with time.
    expect(boardActivity(board, { 'p:p-acme': pulse(10) }, now + 20_000)).toBeLessThan(0.1);
  });
});

describe('energyFrom', () => {
  it('is zero for a quiet board and stays below one', () => {
    expect(energyFrom(0, 0, 0)).toBe(0);
    expect(energyFrom(50, 50, 1e9)).toBeLessThanOrEqual(1);
    expect(energyFrom(50, 50, 1e9)).toBeGreaterThan(0.99);
  });

  it('rises with sessions, project activity and throughput', () => {
    const one = energyFrom(1, 0, 0);
    expect(energyFrom(2, 0, 0)).toBeGreaterThan(one);
    expect(energyFrom(1, 1, 0)).toBeGreaterThan(one);
    expect(energyFrom(1, 0, 64 * 1024)).toBeGreaterThan(one);
  });

  it('keeps a calm board low and a busy one clearly brighter', () => {
    // One working session; the demo board (5 working, ~4 busy projects, a trickle of output);
    // the stress board (two log firehoses, rapid tool calls everywhere).
    const calm = energyFrom(1, 0.5, 0);
    const demo = energyFrom(5, 3.8, 400);
    const stress = energyFrom(4, 8, 25 * 1024);
    expect(calm).toBeLessThan(0.15);
    expect(demo).toBeGreaterThan(0.4);
    expect(demo).toBeLessThan(0.65);
    expect(stress).toBeGreaterThan(0.85);
    expect(stress - demo).toBeGreaterThan(0.25);
  });

  it('treats negative input as zero', () => {
    expect(energyFrom(-3, -1, -100)).toBe(0);
  });
});

describe('ThroughputMeter', () => {
  it('starts at zero and converges on a steady rate', () => {
    const meter = new ThroughputMeter(500);
    expect(meter.sample(0, 0)).toBe(0);
    let rate = 0;
    for (let t = 250; t <= 5000; t += 250) rate = meter.sample((t / 1000) * 4000, t);
    expect(rate).toBeCloseTo(4000, -1);
  });

  it('decays when output stops and ignores counter drops', () => {
    const meter = new ThroughputMeter(500);
    meter.sample(0, 0);
    const busy = meter.sample(10_000, 1000);
    const quiet = meter.sample(10_000, 2000);
    expect(quiet).toBeLessThan(busy);
    expect(meter.sample(0, 3000)).toBeLessThan(quiet);
  });

  it('ignores samples that do not advance time', () => {
    const meter = new ThroughputMeter();
    meter.sample(0, 100);
    expect(meter.sample(5000, 100)).toBe(0);
  });
});

describe('approach', () => {
  it('moves toward the target independently of the frame split', () => {
    const once = approach(0, 1, 200, 400);
    const twice = approach(approach(0, 1, 100, 400), 1, 100, 400);
    expect(once).toBeCloseTo(twice, 10);
    expect(once).toBeGreaterThan(0);
    expect(once).toBeLessThan(1);
  });

  it('snaps without a time constant and holds with no time', () => {
    expect(approach(0, 1, 16, 0)).toBe(1);
    expect(approach(0.3, 1, 0, 400)).toBeCloseTo(0.3, 12);
  });
});

describe('frameDue', () => {
  it('caps a 60 Hz display at every other frame', () => {
    const frame = 1000 / 60;
    let last: number | null = null;
    let drawn = 0;
    for (let i = 0; i < 60; i++) {
      const now = i * frame;
      if (frameDue(last, now, 30)) {
        last = now;
        drawn++;
      }
    }
    expect(drawn).toBe(30);
  });

  it('always renders the first frame', () => {
    expect(frameDue(null, 0, 30)).toBe(true);
  });
});

describe('viewportPoint', () => {
  it('maps a rect center into 0..1 and clamps off-screen rects', () => {
    const viewport = { width: 1000, height: 500 };
    expect(viewportPoint({ left: 100, top: 100, width: 200, height: 100 }, viewport)).toEqual({
      x: 0.2,
      y: 0.3,
    });
    expect(viewportPoint({ left: 2000, top: -900, width: 10, height: 10 }, viewport)).toEqual({
      x: 1,
      y: 0,
    });
  });

  it('falls back for an empty viewport', () => {
    expect(viewportPoint({ left: 0, top: 0, width: 1, height: 1 }, { width: 0, height: 0 })).toBe(
      DEFAULT_ATTENTION_POINT,
    );
  });
});

describe('AttentionPoint', () => {
  const pod = { id: 'pod' };
  const other = { id: 'other' };
  const counting = () => {
    let calls = 0;
    return {
      measure: () => {
        calls++;
        return { x: calls / 10, y: 0.5 };
      },
      calls: () => calls,
    };
  };

  it('measures once per element until invalidated', () => {
    const point = new AttentionPoint<object>();
    const m = counting();
    expect(point.read(pod, 'a', 0, m.measure)).toEqual({ x: 0.1, y: 0.5 });
    point.read(pod, 'a', 250, m.measure);
    point.read(pod, 'a', 500, m.measure);
    expect(m.calls()).toBe(1);
    point.invalidate();
    expect(point.read(pod, 'a', 750, m.measure)).toEqual({ x: 0.2, y: 0.5 });
    point.read(other, 'a', 1000, m.measure);
    expect(m.calls()).toBe(3);
  });

  it('keeps measuring while the pods reorder, then settles', () => {
    const point = new AttentionPoint<object>();
    const m = counting();
    point.read(pod, 'a', 0, m.measure);
    point.read(pod, 'b', 100, m.measure);
    point.read(pod, 'b', 350, m.measure);
    point.read(pod, 'b', 100 + REORDER_SETTLE_MS - 1, m.measure);
    expect(m.calls()).toBe(4);
    point.read(pod, 'b', 100 + REORDER_SETTLE_MS, m.measure);
    point.read(pod, 'b', 100 + REORDER_SETTLE_MS + 250, m.measure);
    expect(m.calls()).toBe(4);
  });

  it('refreshes a point that has grown old', () => {
    const point = new AttentionPoint<object>();
    const m = counting();
    point.read(pod, 'a', 0, m.measure);
    point.read(pod, 'a', ATTENTION_POINT_MAX_AGE_MS - 1, m.measure);
    expect(m.calls()).toBe(1);
    point.read(pod, 'a', ATTENTION_POINT_MAX_AGE_MS, m.measure);
    expect(m.calls()).toBe(2);
  });

  it('falls back without an element', () => {
    const point = new AttentionPoint<object>();
    const m = counting();
    expect(point.read(null, 'a', 0, m.measure)).toBe(DEFAULT_ATTENTION_POINT);
    expect(m.calls()).toBe(0);
  });
});

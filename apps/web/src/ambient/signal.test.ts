import type { Approval, Execution } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { makeSession, sampleBoard } from '../test/board.js';
import {
  activeSessionCount,
  approach,
  attentionProjectId,
  DEFAULT_ATTENTION_POINT,
  energyFrom,
  frameDue,
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

describe('energyFrom', () => {
  it('is zero for a quiet board and stays below one', () => {
    expect(energyFrom(0, 0, 0)).toBe(0);
    expect(energyFrom(50, 50, 1e9)).toBeLessThanOrEqual(1);
    expect(energyFrom(50, 50, 1e9)).toBeGreaterThan(0.99);
  });

  it('rises with sessions, commands and throughput', () => {
    const one = energyFrom(1, 0, 0);
    expect(energyFrom(2, 0, 0)).toBeGreaterThan(one);
    expect(energyFrom(1, 1, 0)).toBeGreaterThan(one);
    expect(energyFrom(1, 0, 64 * 1024)).toBeGreaterThan(one);
    // A session matters more than a command.
    expect(energyFrom(1, 0, 0)).toBeGreaterThan(energyFrom(0, 1, 0));
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

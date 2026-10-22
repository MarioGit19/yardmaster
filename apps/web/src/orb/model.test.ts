import type { SessionStatus } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import {
  countdownProgress,
  enterEffect,
  FAMILY_TOKEN,
  finishCountdown,
  orbAnimates,
  orbLabel,
  orbStateFor,
  particleCount,
} from './model.js';

describe('orbStateFor', () => {
  const cases: [SessionStatus, string][] = [
    [{ kind: 'idle' }, 'idle'],
    [{ kind: 'working' }, 'working'],
    [{ kind: 'tool', tool: 'Bash', toolUseId: null }, 'tool'],
    [{ kind: 'waiting_permission', approvalId: null }, 'waiting'],
    [{ kind: 'waiting_input' }, 'waiting'],
    [{ kind: 'error', message: null }, 'error'],
    [{ kind: 'compacting', previous: { kind: 'working' } }, 'compacting'],
    [{ kind: 'unknown', alive: true }, 'idle'],
    [{ kind: 'unknown', alive: false }, 'ended'],
    [{ kind: 'ended' }, 'ended'],
  ];
  it.each(cases)('%o → %s', (status, state) => {
    expect(orbStateFor(status)).toBe(state);
  });
});

describe('enterEffect', () => {
  it('plays a ripple on entering waiting, a glitch on error, and a sweep after a turn', () => {
    expect(enterEffect('working', 'waiting')).toBe('ripple');
    expect(enterEffect('tool', 'error')).toBe('glitch');
    expect(enterEffect('working', 'idle')).toBe('sweep');
    expect(enterEffect('tool', 'idle')).toBe('sweep');
  });

  it('eases a compacted orb back to size', () => {
    expect(enterEffect('compacting', 'working')).toBe('expand');
    expect(enterEffect('compacting', 'idle')).toBe('expand');
    expect(enterEffect('compacting', 'waiting')).toBe('ripple');
  });

  it('plays nothing on mount, on repeats, or for other transitions', () => {
    expect(enterEffect(null, 'waiting')).toBeNull();
    expect(enterEffect('waiting', 'waiting')).toBeNull();
    expect(enterEffect('ended', 'idle')).toBeNull();
    expect(enterEffect('waiting', 'idle')).toBeNull();
    expect(enterEffect('idle', 'working')).toBeNull();
  });
});

describe('orbAnimates', () => {
  it('registers frames only for states that move', () => {
    expect(orbAnimates('working', 0)).toBe(true);
    expect(orbAnimates('tool', 0)).toBe(true);
    expect(orbAnimates('waiting', 0)).toBe(true);
    expect(orbAnimates('compacting', 0)).toBe(true);
    expect(orbAnimates('idle', 0)).toBe(false);
    expect(orbAnimates('error', 0)).toBe(false);
    expect(orbAnimates('ended', 0)).toBe(false);
  });

  it('animates satellites, except on an ended orb', () => {
    expect(orbAnimates('idle', 2)).toBe(true);
    expect(orbAnimates('ended', 2)).toBe(false);
  });
});

describe('tool particles', () => {
  it('colors by family: Bash cyan, edits violet, reads blue, web teal, Task pink', () => {
    expect(FAMILY_TOKEN.bash).toBe('--st-tool');
    expect(FAMILY_TOKEN.edit).toBe('--orb-edit');
    expect(FAMILY_TOKEN.read).toBe(FAMILY_TOKEN.search);
    expect(FAMILY_TOKEN.web).toBe('--orb-web');
    expect(FAMILY_TOKEN.task).toBe('--orb-task');
  });

  it('uses 3–6 particles, stable per tool', () => {
    for (const tool of ['Bash', 'Edit', 'Read', 'Grep', 'WebFetch', 'Task', 'mcp__x__y', null]) {
      const n = particleCount(tool);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
      expect(particleCount(tool)).toBe(n);
    }
  });
});

describe('countdownProgress', () => {
  it('is null without a timeout and clamps to 0..1', () => {
    expect(countdownProgress(null, 0)).toBeNull();
    const countdown = { startedAt: 1000, endsAt: 3000 };
    expect(countdownProgress(countdown, 500)).toBe(0);
    expect(countdownProgress(countdown, 2000)).toBe(0.5);
    expect(countdownProgress(countdown, 9000)).toBe(1);
    expect(countdownProgress({ startedAt: 5, endsAt: 5 }, 0)).toBe(1);
  });
});

describe('orbLabel', () => {
  it('names the state, tool and subagents for assistive tech', () => {
    expect(orbLabel('tool', 'Bash', 0)).toBe('Using Bash');
    expect(orbLabel('waiting', null, 0)).toBe('Waiting for you');
    expect(orbLabel('working', null, 1)).toBe('Thinking, 1 subagent');
    expect(orbLabel('working', null, 3)).toBe('Thinking, 3 subagents');
  });
});

describe('finishCountdown', () => {
  it('runs the rest of the ring out in the given time, from where it is', () => {
    const finish = finishCountdown({ startedAt: 0, endsAt: 10_000 }, 4000, 600);
    expect(finish.endsAt).toBe(4600);
    expect(countdownProgress(finish, 4000)).toBeCloseTo(0.4);
    expect(countdownProgress(finish, 4300)).toBeCloseTo(0.7);
    expect(countdownProgress(finish, 4600)).toBe(1);
  });

  it('leaves a finished countdown alone', () => {
    const over = { startedAt: 0, endsAt: 1000 };
    expect(finishCountdown(over, 2000, 600)).toBe(over);
  });
});

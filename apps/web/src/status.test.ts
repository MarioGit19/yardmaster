import { describe, expect, it } from 'vitest';
import { formatCount, projectTone, sessionStatusView } from './status.js';
import { makeSession, makeTerminal } from './test/board.js';

describe('sessionStatusView', () => {
  it('maps every status kind to a tone and a label', () => {
    expect(sessionStatusView({ kind: 'idle' })).toEqual({ tone: 'idle', label: 'Idle' });
    expect(sessionStatusView({ kind: 'tool', tool: 'Bash', toolUseId: null })).toEqual({
      tone: 'tool',
      label: 'Using Bash',
    });
    expect(sessionStatusView({ kind: 'waiting_input' }).tone).toBe('wait');
    expect(sessionStatusView({ kind: 'error', message: null }).tone).toBe('err');
    expect(sessionStatusView({ kind: 'error', message: null, reason: 'rate_limit' })).toEqual({
      tone: 'err',
      label: 'Rate limited',
    });
    expect(sessionStatusView({ kind: 'compacting', previous: { kind: 'working' } }).label).toBe(
      'Compacting',
    );
    expect(sessionStatusView({ kind: 'unknown', alive: true }).label).toBe('Running');
    expect(sessionStatusView({ kind: 'ended' }).tone).toBe('idle');
  });
});

describe('projectTone', () => {
  const working = makeSession('a', 'p', { kind: 'tool', tool: 'Edit', toolUseId: null });
  const waiting = makeSession('b', 'p', { kind: 'waiting_permission', approvalId: null });
  const failed = makeSession('c', 'p', { kind: 'error', message: 'boom' });

  it('ranks wait over err over work', () => {
    expect(projectTone([working, failed, waiting], [])).toBe('wait');
    expect(projectTone([working, failed], [])).toBe('err');
    expect(projectTone([working], [])).toBe('work');
    expect(projectTone([], [])).toBe('idle');
  });

  it('counts a non-zero terminal exit as an error', () => {
    expect(projectTone([], [makeTerminal('t', 'p', 2)])).toBe('err');
    expect(projectTone([], [makeTerminal('t', 'p', 0)])).toBe('idle');
  });
});

describe('formatCount', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatCount(950)).toBe('950');
    expect(formatCount(12_400)).toBe('12.4k');
    expect(formatCount(2000)).toBe('2k');
    expect(formatCount(999_999)).toBe('1M');
    expect(formatCount(3_250_000)).toBe('3.3M');
  });

  it('rolls over to the next unit instead of showing "1000k"', () => {
    expect(formatCount(999_499)).toBe('999k');
    expect(formatCount(999_949)).toBe('1M');
    expect(formatCount(999_600_000)).toBe('1B');
    expect(formatCount(11_442_000_000)).toBe('11.4B');
    expect(formatCount(114_416_000_000)).toBe('114B');
    expect(formatCount(2_500_000_000_000)).toBe('2.5T');
  });

  it('never renders NaN', () => {
    expect(formatCount(Number.NaN)).toBe('0');
    expect(formatCount(0)).toBe('0');
  });
});

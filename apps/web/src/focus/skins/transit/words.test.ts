import { describe, expect, it } from 'vitest';
import { boardWord } from './words.js';

describe('Transit board words', () => {
  it('words a session as the departures board does', () => {
    const word = (status: object) => boardWord({ kind: 'session', status } as never);
    expect(word({ kind: 'waiting_permission', approvalId: 'a1' })).toBe('Due · needs you');
    expect(word({ kind: 'waiting_input' })).toBe('Due · needs you');
    expect(word({ kind: 'error' })).toBe('Cancelled');
    expect(word({ kind: 'working' })).toBe('Departing');
    expect(word({ kind: 'compacting' })).toBe('Departing');
    expect(word({ kind: 'tool', tool: 'Bash' })).toBe('Departing · Bash');
    expect(word({ kind: 'idle' })).toBe('At platform');
    expect(word({ kind: 'unknown', alive: true })).toBe('In service');
    expect(word({ kind: 'unknown', alive: false })).toBe('At platform');
    expect(word({ kind: 'interrupted' })).toBe('Held · interrupted');
    expect(word({ kind: 'ended' })).toBe('Out of service');
  });

  it('words a terminal by what it is doing and how it ended', () => {
    const word = (running: boolean, exit: number | null, closed = false) =>
      boardWord({ kind: 'terminal', running, exit, closed });
    expect(word(true, null)).toBe('Departing');
    expect(word(false, 0)).toBe('Arrived');
    expect(word(false, 2)).toBe('Cancelled · exit 2');
    expect(word(false, null)).toBe('At platform');
    expect(word(false, null, true)).toBe('Out of service');
  });
});

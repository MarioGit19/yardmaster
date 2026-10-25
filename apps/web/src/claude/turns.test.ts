import { describe, expect, it } from 'vitest';
import { turnHead } from './turns.js';

const hhmm = (ts: number) => `t${ts}`;

describe('turnHead', () => {
  const items = [
    { kind: 'user', ts: 1 },
    { kind: 'assistant', ts: 2 },
    { kind: 'tool', ts: 3 },
    { kind: 'assistant', ts: 4 },
    { kind: 'user', ts: 5 },
    { kind: 'user', ts: 6 },
    { kind: 'tail' },
  ];

  it('opens a turn where the speaker changes', () => {
    const heads = items.map((_, i) => turnHead(items, i, hhmm));
    expect(heads).toEqual([
      { speaker: 'you', label: 'YOU · t1' },
      { speaker: 'claude', label: 'CLAUDE · t2' },
      null,
      null,
      { speaker: 'you', label: 'YOU · t5' },
      null,
      { speaker: 'claude', label: 'CLAUDE' },
    ]);
  });

  it('starts again after the fork divider, which has no header', () => {
    const forked = [{ kind: 'assistant', ts: 1 }, { kind: 'fork' }, { kind: 'assistant', ts: 9 }];
    expect(turnHead(forked, 1, hhmm)).toBeNull();
    expect(turnHead(forked, 2, hhmm)).toEqual({ speaker: 'claude', label: 'CLAUDE · t9' });
  });

  it('is null past the end', () => {
    expect(turnHead(items, 99, hhmm)).toBeNull();
  });
});

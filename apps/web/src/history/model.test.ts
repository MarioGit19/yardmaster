import type { SessionHistoryEntry } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { historyTitle, historyTokens, pastSessions } from './model.js';

const entry = (id: string, updatedAt: number): SessionHistoryEntry => ({
  id,
  projectId: 'p1',
  title: null,
  firstPrompt: null,
  cwd: null,
  gitBranch: null,
  createdAt: null,
  updatedAt,
  fileSize: null,
  tokens: null,
});

describe('pastSessions', () => {
  it('drops sessions already on the board and sorts newest first', () => {
    const list = pastSessions([entry('a', 1), entry('b', 3), entry('c', 2)], new Set(['c']));
    expect(list.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('historyTitle', () => {
  it('prefers the title, then the first prompt', () => {
    expect(historyTitle({ title: 'Fix tax', firstPrompt: 'fix it' })).toBe('Fix tax');
    expect(historyTitle({ title: null, firstPrompt: 'fix it' })).toBe('fix it');
    expect(historyTitle({ title: null, firstPrompt: null })).toBe('Untitled session');
  });
});

describe('historyTokens', () => {
  it('sums usage, or null when unknown', () => {
    expect(historyTokens({ tokens: null })).toBeNull();
    expect(historyTokens({ tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } })).toBe(
      10,
    );
  });
});

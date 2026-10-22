import type { Approval, ClaudeSession } from '@c-board/protocol';
import { describe, expect, it } from 'vitest';
import { createBoardStore } from '../data/index.js';
import { makeSession, sampleBoard } from '../test/board.js';
import {
  attentionRank,
  isStreaming,
  lastLine,
  orderPods,
  podSessions,
  selectPodOrder,
  sessionCaption,
} from './model.js';

const session = (status: ClaudeSession['status'], over: Partial<ClaudeSession> = {}) => ({
  ...makeSession('s', 'p', status, 'Checkout fix'),
  ...over,
});

const tool = (name: string, summary: string | null): ClaudeSession['currentTool'] => ({
  id: 'toolu_1',
  sessionId: 's',
  tool: name,
  family: 'other',
  summary,
  startedAt: 0,
  endedAt: null,
  status: 'running',
});

describe('attention order', () => {
  it('ranks waiting above errors above everything else', () => {
    expect(attentionRank('wait')).toBeGreaterThan(attentionRank('err'));
    expect(attentionRank('err')).toBeGreaterThan(attentionRank('work'));
    expect(attentionRank('work')).toBe(attentionRank('idle'));
  });

  it('puts urgent pods first and keeps the rest by name', () => {
    expect(
      orderPods([
        { id: 'c', name: 'charlie', rank: 0 },
        { id: 'a', name: 'alpha', rank: 0 },
        { id: 'e', name: 'echo', rank: 1 },
        { id: 'w', name: 'whiskey', rank: 2 },
      ]),
    ).toEqual(['w', 'e', 'a', 'c']);
  });

  it('orders the board: waiting, then the crashed terminal, then by name', () => {
    const store = createBoardStore();
    store.getState().replaceBoard(sampleBoard());
    // acme-shop waits, zen-notes has a crashed terminal, orbit-api is only working.
    expect(selectPodOrder(store.getState())).toEqual(['p-acme', 'p-zen', 'p-orbit']);
  });
});

describe('podSessions', () => {
  it('drops ended sessions and puts the most urgent first, then the newest', () => {
    const list = [
      { ...makeSession('idle', 'p', { kind: 'idle' }), startedAt: 3 },
      { ...makeSession('gone', 'p', { kind: 'ended' }), startedAt: 9 },
      { ...makeSession('work-old', 'p', { kind: 'working' }), startedAt: 1 },
      { ...makeSession('work-new', 'p', { kind: 'working' }), startedAt: 2 },
      { ...makeSession('wait', 'p', { kind: 'waiting_input' }), startedAt: 0 },
    ];
    expect(podSessions(list).map((s) => s.id)).toEqual(['wait', 'work-new', 'work-old', 'idle']);
  });
});

describe('sessionCaption', () => {
  it('describes the running tool with its glyph', () => {
    const edit = session(
      { kind: 'tool', tool: 'Edit', toolUseId: null },
      { currentTool: tool('Edit', 'src/cart.ts') },
    );
    expect(sessionCaption(edit)).toEqual({
      glyph: '✎',
      text: 'Editing src/cart.ts',
      tone: 'active',
    });
    const grep = session(
      { kind: 'tool', tool: 'Grep', toolUseId: null },
      { currentTool: tool('Grep', 'totals') },
    );
    expect(sessionCaption(grep).text).toBe('Searching "totals"');
    const bash = session(
      { kind: 'tool', tool: 'Bash', toolUseId: null },
      { currentTool: tool('Bash', 'pnpm test') },
    );
    expect(sessionCaption(bash)).toMatchObject({ glyph: '▶', text: 'pnpm test' });
  });

  it('ignores a stale summary from another tool', () => {
    const s = session(
      { kind: 'tool', tool: 'Read', toolUseId: null },
      { currentTool: tool('Edit', 'src/cart.ts') },
    );
    expect(sessionCaption(s).text).toBe('Reading');
  });

  it('names what a waiting session needs, in the wait tone', () => {
    const approval = { tool: 'Bash' } as Approval;
    const s = session(
      { kind: 'waiting_permission', approvalId: 'a1' },
      { currentTool: tool('Bash', 'pnpm test') },
    );
    expect(sessionCaption(s, approval)).toEqual({
      glyph: '!',
      text: 'Waiting for approval: Bash(pnpm test)',
      tone: 'wait',
    });
    expect(sessionCaption(session({ kind: 'waiting_input' })).tone).toBe('wait');
  });

  it('shows errors and resting states', () => {
    expect(sessionCaption(session({ kind: 'error', message: 'Overloaded' }))).toMatchObject({
      text: 'Error: Overloaded',
      tone: 'err',
    });
    expect(sessionCaption(session({ kind: 'idle' }))).toMatchObject({
      text: 'Checkout fix',
      tone: 'rest',
    });
    expect(sessionCaption(session({ kind: 'idle' }, { title: null })).text).toBe('Idle');
    expect(sessionCaption(session({ kind: 'working' })).text).toBe('Thinking…');
  });
});

describe('lastLine', () => {
  it('takes the last meaningful line, whitespace collapsed', () => {
    expect(lastLine('First.\n\n  Then   the totals.  \n```\n')).toBe('Then the totals.');
    expect(lastLine('')).toBeNull();
    expect(lastLine(null)).toBeNull();
    expect(lastLine('---\n')).toBeNull();
  });
});

describe('isStreaming', () => {
  it('is true while thinking or running a tool', () => {
    expect(isStreaming(session({ kind: 'working' }))).toBe(true);
    expect(isStreaming(session({ kind: 'tool', tool: 'Read', toolUseId: null }))).toBe(true);
    expect(isStreaming(session({ kind: 'idle' }))).toBe(false);
  });
});

import type { Approval, ClaudeSession } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import { createBoardStore } from '../data/index.js';
import { makeSession, sampleBoard } from '../test/board.js';
import {
  attentionRank,
  isStreaming,
  lastLine,
  orderPods,
  podSessions,
  risingPods,
  selectPodOrder,
  sessionCaption,
  sessionWhen,
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
    expect(sessionCaption(session({ kind: 'idle' }, { lastAssistantText: null }))).toMatchObject({
      text: 'Checkout fix',
      tone: 'rest',
    });
    const blank = { title: null, lastAssistantText: null };
    expect(sessionCaption(session({ kind: 'idle' }, blank)).text).toBe('Ready');
    expect(sessionCaption(session({ kind: 'working' })).text).toBe('Thinking…');
  });
});

describe('the one line on a card', () => {
  it('leads an idle session with what it produced, cut to one line', () => {
    const s = session({ kind: 'idle' }, { lastAssistantText: 'Checked it.\n\nAll 12 tests pass.' });
    expect(sessionCaption(s).text).toBe('All 12 tests pass.');
    const long = session({ kind: 'idle' }, { lastAssistantText: 'x'.repeat(5_000) });
    expect(sessionCaption(long).text).toHaveLength(240);
  });

  it('skips the automatic session name', () => {
    const s = session(
      { kind: 'idle' },
      { title: 'acme-shop-c3', cwd: '/home/dev/acme-shop', lastAssistantText: null },
    );
    expect(sessionCaption(s).text).toBe('Ready');
  });
});

describe('sessionWhen', () => {
  const now = 10 * 60_000;

  it('counts a blocked session from the approval, else its last change', () => {
    const blocked = session({ kind: 'waiting_input' }, { updatedAt: now - 3 * 60_000 });
    expect(sessionWhen(blocked, null, now)?.text).toBe('waiting 3m');
    const asked = session({ kind: 'waiting_permission', approvalId: 'a1' });
    const approval = { createdAt: now - 5 * 60_000 } as Approval;
    expect(sessionWhen(asked, approval, now)?.text).toBe('waiting 5m');
  });

  it('dates a quiet session by its last reply and leaves a running one undated', () => {
    const quiet = session({ kind: 'idle' }, { lastAssistantAt: now - 4 * 60_000, updatedAt: now });
    expect(sessionWhen(quiet, null, now)).toEqual({ text: '4m ago', at: now - 4 * 60_000 });
    expect(sessionWhen(session({ kind: 'working' }), null, now)).toBeNull();
  });
});

describe('lastLine', () => {
  it('passes over a line that only introduces a code block', () => {
    expect(lastLine('Totals are fixed.\n\nThe core of it:\n\n```ts\nx\n```')).toBe(
      'Totals are fixed.',
    );
    expect(lastLine('The core of it:\n\n```ts\nx\n```')).toBe('The core of it:');
  });

  it('takes the last meaningful line, whitespace collapsed', () => {
    expect(lastLine('First.\n\n  Then   the totals.  \n```\n')).toBe('Then the totals.');
    expect(lastLine('')).toBeNull();
    expect(lastLine(null)).toBeNull();
    expect(lastLine('---\n')).toBeNull();
  });

  it('skips code blocks, bracket-only lines and markdown markers', () => {
    expect(lastLine('The fix:\n```ts\nif (a) {\n  run();\n}\n```\n')).toBe('The fix:');
    // Still streaming: the fence isn't closed yet.
    expect(lastLine('Here it is:\n```ts\nconst x = 1;')).toBe('Here it is:');
    expect(lastLine('Changed:\n- `src/checkout/tax.ts`')).toBe('src/checkout/tax.ts');
    expect(lastLine('## Summary\n> Totals round per line.\n});')).toBe('Totals round per line.');
  });
});

describe('isStreaming', () => {
  it('is true while thinking or running a tool', () => {
    expect(isStreaming(session({ kind: 'working' }))).toBe(true);
    expect(isStreaming(session({ kind: 'tool', tool: 'Read', toolUseId: null }))).toBe(true);
    expect(isStreaming(session({ kind: 'idle' }))).toBe(false);
  });
});

describe('risingPods', () => {
  it('marks the pods that overtook a neighbour', () => {
    expect(risingPods(['a', 'b', 'c', 'd'], ['c', 'a', 'b', 'd'])).toEqual(new Set(['c']));
    expect(risingPods(['a', 'b'], ['b', 'a'])).toEqual(new Set(['b']));
  });

  it('ignores pods that only close a gap or make room', () => {
    expect(risingPods(['a', 'b', 'c'], ['b', 'c'])).toEqual(new Set());
    expect(risingPods(['a', 'b'], ['x', 'a', 'b'])).toEqual(new Set());
    expect(risingPods(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(new Set());
  });
});

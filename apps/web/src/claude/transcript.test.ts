import type { ChatMessage } from '@yardmaster/protocol';
import { describe, expect, it } from 'vitest';
import {
  inheritedRows,
  streamingTail,
  TranscriptModel,
  type TranscriptRow,
  toolSummary,
} from './transcript.js';

const base = { uuid: null, ts: 1_760_000_000_000 };
const assistant = { messageId: 'msg_1', model: null, usage: null };

const user = (id: string, text: string, meta = false): ChatMessage => ({
  ...base,
  id,
  kind: 'user',
  text,
  meta,
});
const said = (id: string, text: string): ChatMessage => ({
  ...base,
  ...assistant,
  id,
  kind: 'assistant',
  text,
});

describe('TranscriptModel', () => {
  it('builds rows, attaches tool results and skips injected messages', () => {
    const model = new TranscriptModel();
    model.push([
      user('u1', 'Fix the tax rounding'),
      user('u2', '<system-reminder>…</system-reminder>', true),
      { ...base, ...assistant, id: 't1', kind: 'thinking', text: 'Read the module first.' },
      {
        ...base,
        ...assistant,
        id: 'a1',
        kind: 'tool_use',
        toolUseId: 'toolu_1',
        name: 'Read',
        input: { file_path: '/home/dev/acme-shop/src/tax.ts' },
      },
      said('a2', 'Found it.'),
    ]);
    expect(model.rows.map((r) => r.kind)).toEqual(['user', 'thinking', 'tool', 'assistant']);
    const before = model.rows;

    model.push([
      { ...base, id: 'r1', kind: 'tool_result', toolUseId: 'toolu_1', text: 'ok', isError: false },
    ]);
    expect(model.rows[2]).toMatchObject({ kind: 'tool', result: { text: 'ok', isError: false } });
    // Untouched rows keep their identity, so memoized rows don't re-render.
    expect(model.rows[0]).toBe(before[0]);
    expect(model.rows[3]).toBe(before[3]);
    expect(model.rows).not.toBe(before);
  });

  it('ignores duplicates, orphan results, empty text and bad chunks', () => {
    const model = new TranscriptModel();
    expect(model.push([said('a1', 'One')])).toBe(true);
    expect(model.push([said('a1', 'One')])).toBe(false);
    expect(
      model.push([
        { ...base, id: 'r', kind: 'tool_result', toolUseId: 'nope', text: 'x', isError: true },
        said('a2', '   '),
      ]),
    ).toBe(false);
    expect(
      model.pushChunks(['not json', '{"kind":"user"}', JSON.stringify(said('a3', 'Two'))]),
    ).toBe(true);
    expect(model.rows.map((r) => r.id)).toEqual(['a1', 'a3']);
  });
});

describe('streamingTail', () => {
  const model = new TranscriptModel();
  model.push([user('u1', 'Go'), said('a1', 'Done with the first part.')]);
  const text = (t: string | null, at: number | null = null) => ({ text: t, at });

  it('shows text that is not in the transcript yet, only while working', () => {
    expect(streamingTail(model.rows, text('Now the second'), true)).toBe('Now the second');
    expect(streamingTail(model.rows, text('Now the second'), false)).toBeNull();
    expect(streamingTail(model.rows, text(''), true)).toBeNull();
    expect(streamingTail(model.rows, text(null), true)).toBeNull();
  });

  it('hides the tail once the block is in the transcript', () => {
    expect(streamingTail(model.rows, text('Done with the first part.'), true)).toBeNull();
  });

  it('never shows the previous turn’s answer under a new message', () => {
    const turns = new TranscriptModel();
    turns.push([
      { ...user('u1', 'Fix the cart'), ts: 1_000 },
      { ...said('a1', 'Partial notes'), ts: 2_000 },
      { ...user('u2', 'Now add tests'), ts: 5_000 },
      {
        ...base,
        ...assistant,
        id: 'tu',
        ts: 5_500,
        kind: 'tool_use',
        toolUseId: 'tu',
        name: 'Bash',
        input: {},
      },
    ]);
    // The first turn's Stop set its final answer, then the second prompt went in.
    expect(streamingTail(turns.rows, text('Cart fixed.', 3_000), true)).toBeNull();
    expect(streamingTail(turns.rows, text('Writing the tests', 6_000), true)).toBe(
      'Writing the tests',
    );
    // Unstamped text from an older server still falls back to matching the transcript.
    expect(streamingTail(turns.rows, text('Writing the tests'), true)).toBe('Writing the tests');
  });
});

describe('toolSummary', () => {
  it('picks the most telling input field', () => {
    expect(toolSummary('Bash', { command: 'pnpm test' })).toBe('pnpm test');
    expect(
      toolSummary('Edit', { file_path: '/home/dev/acme-shop/src/a.ts' }, '/home/dev/acme-shop'),
    ).toBe('src/a.ts');
    expect(toolSummary('Grep', { pattern: 'applyDiscount' })).toBe('applyDiscount');
    expect(toolSummary('Task', { description: 'Find callers' })).toBe('Find callers');
    expect(toolSummary('Mystery', null)).toBe('');
  });
});

describe('inheritedRows', () => {
  const row = (id: string, ts: number | null): TranscriptRow => ({
    kind: 'user',
    id,
    ts,
    text: id,
  });
  it('counts the rows a fork took over from its parent', () => {
    const rows = [row('a', 100), row('b', 200), row('c', 300)];
    expect(inheritedRows(rows, 200)).toBe(2);
    expect(inheritedRows(rows, 50)).toBe(0);
    expect(inheritedRows(rows, null)).toBe(0);
    expect(inheritedRows([row('a', null), row('b', 100)], 200)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { TranscriptRow } from '../claude/transcript.js';
import { maskedSnippet, rowForMessage, searchParams } from './model.js';

const draft = { query: ' cart ', projectId: '', date: 'any', status: 'all' } as const;

describe('searchParams', () => {
  it('has nothing to send without words', () => {
    expect(searchParams({ ...draft, query: '  ' }, 40, 0)).toBeNull();
  });

  it('sends the trimmed words and only the filters in use', () => {
    const params = searchParams(draft, 40, 0);
    expect(Object.fromEntries(params ?? [])).toEqual({ q: 'cart', status: 'all', limit: '40' });
  });

  it('turns the date choice into a start time', () => {
    const now = 30 * 24 * 60 * 60 * 1000;
    const params = searchParams({ ...draft, date: '7', projectId: 'acme' }, 40, now);
    expect(params?.get('from')).toBe(String(23 * 24 * 60 * 60 * 1000));
    expect(params?.get('projectId')).toBe('acme');
  });
});

describe('maskedSnippet', () => {
  const secret = `sk-ant-${'a'.repeat(32)}`;

  it('keeps the highlights when nothing needs masking', () => {
    const runs = [
      { text: 'a ', hit: false },
      { text: 'word', hit: true },
    ];
    expect(maskedSnippet(runs, true)).toEqual(runs);
  });

  it('masks a secret even when the highlight splits it', () => {
    const runs = [
      { text: secret.slice(0, 12), hit: false },
      { text: secret.slice(12), hit: true },
    ];
    const text = maskedSnippet(runs, true)
      .map((run) => run.text)
      .join('');
    expect(text).not.toContain(secret);
  });

  it('leaves everything as it is with redaction off', () => {
    const runs = [{ text: secret, hit: true }];
    expect(maskedSnippet(runs, false)).toEqual(runs);
  });
});

describe('rowForMessage', () => {
  const rows: TranscriptRow[] = [
    { kind: 'user', id: 'u1:0', ts: null, text: 'hi' },
    {
      kind: 'tool',
      id: 't1:0',
      ts: null,
      toolUseId: 'tool_1',
      name: 'Bash',
      input: {},
      result: null,
    },
  ];

  it('finds a message by its own row', () => {
    expect(rowForMessage(rows, [], 'u1:0')).toBe('u1:0');
  });

  it('finds a tool result in the row of its call', () => {
    const messages = [{ id: 'r1:0', kind: 'tool_result', toolUseId: 'tool_1' }];
    expect(rowForMessage(rows, messages, 'r1:0')).toBe('t1:0');
  });

  it('has no row for an unknown message or none asked for', () => {
    expect(rowForMessage(rows, [], 'gone')).toBeNull();
    expect(rowForMessage(rows, [], undefined)).toBeNull();
  });
});

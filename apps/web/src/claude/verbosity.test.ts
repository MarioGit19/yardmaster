import { describe, expect, it } from 'vitest';
import type { TranscriptRow } from './transcript.js';
import { nearestShown, shownRows } from './verbosity.js';

const text = (kind: 'user' | 'assistant' | 'thinking', id: string): TranscriptRow => ({
  kind,
  id,
  ts: 1,
  text: id,
});
const tool = (id: string, name: string, isError = false): TranscriptRow => ({
  kind: 'tool',
  id,
  ts: 1,
  toolUseId: id,
  name,
  input: {},
  result: { text: '', isError },
});

const rows = [
  text('user', 'ask'),
  text('thinking', 'think'),
  tool('read', 'Read'),
  tool('bash-bad', 'Bash', true),
  tool('bash', 'Bash'),
  tool('edit', 'Edit'),
  tool('task', 'Task'),
  text('assistant', 'answer'),
];

describe('shownRows', () => {
  it('keeps what was said and what came of it in Summary', () => {
    expect(shownRows(rows, 'summary').map((r) => r.id)).toEqual([
      'ask',
      'bash-bad',
      'edit',
      'task',
      'answer',
    ]);
  });

  it('shows every row at Normal and Verbose', () => {
    expect(shownRows(rows, 'normal')).toBe(rows);
    expect(shownRows(rows, 'verbose')).toBe(rows);
  });
});

describe('nearestShown', () => {
  const summary = shownRows(rows, 'summary');

  it('keeps a row the level still shows', () => {
    expect(nearestShown(rows, summary, 'edit')).toBe('edit');
  });

  it('moves on to the next row the level shows', () => {
    expect(nearestShown(rows, summary, 'think')).toBe('bash-bad');
  });

  it('falls back to the last row past the end, and to nothing for an unknown row', () => {
    const short = [text('user', 'a'), text('thinking', 'b')];
    expect(nearestShown(short, shownRows(short, 'summary'), 'b')).toBe('a');
    expect(nearestShown(rows, summary, 'gone')).toBeNull();
  });
});

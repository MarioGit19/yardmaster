import { describe, expect, it } from 'vitest';
import { buildHunk, segments, splitRows } from './diff.js';

describe('buildHunk', () => {
  it('numbers lines and marks the words that changed', () => {
    const hunk = buildHunk(
      'const a = 1;\nreturn rules.reduce(f);\n}',
      'const a = 1;\nreturn ordered.reduce(f);\n}',
      10,
    );
    expect(hunk.added).toBe(1);
    expect(hunk.removed).toBe(1);
    expect(hunk.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['ctx', 12, 12],
    ]);
    const del = hunk.lines[1];
    const add = hunk.lines[2];
    expect(del?.marks.map(([s, e]) => del.text.slice(s, e))).toEqual(['rules']);
    expect(add?.marks.map(([s, e]) => add.text.slice(s, e))).toEqual(['ordered']);
  });

  it('leaves numbers out when the position is unknown', () => {
    const hunk = buildHunk('a', 'b', null);
    expect(hunk.lines.every((l) => l.oldNo === null && l.newNo === null)).toBe(true);
  });

  it('treats a new file as all additions and normalizes line endings', () => {
    const hunk = buildHunk('', 'one\r\ntwo\r\n', 1);
    expect(hunk.lines.map((l) => [l.type, l.newNo, l.text])).toEqual([
      ['add', 1, 'one'],
      ['add', 2, 'two'],
    ]);
    expect(hunk.newText).toBe('one\ntwo\n');
  });

  it('skips word marks on lines that were rewritten', () => {
    const hunk = buildHunk('alpha beta gamma', 'completely different text', 1);
    expect(hunk.lines.every((l) => l.marks.length === 0)).toBe(true);
  });

  it('indexes lines for token lookup', () => {
    const hunk = buildHunk('x\ny\nz', 'x\nY\nz\nw', 1);
    expect(hunk.lines.map((l) => [l.type, l.oldIdx, l.newIdx])).toEqual([
      ['ctx', 0, 0],
      ['del', 1, null],
      ['add', null, 1],
      ['ctx', 2, 2],
      ['add', null, 3],
    ]);
  });
});

describe('splitRows', () => {
  it('pairs removals with additions and pads the shorter side', () => {
    const hunk = buildHunk('a\nb\nc', 'a\nB\nB2\nc', 1);
    const rows = splitRows(hunk.lines);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      [null, 'B2'],
      ['c', 'c'],
    ]);
  });
});

describe('segments', () => {
  it('splits syntax tokens at changed-word edges', () => {
    const text = 'return ordered;';
    const parts = segments(
      text,
      [
        ['return', 'var(--k)'],
        [' ordered;', 'var(--t)'],
      ],
      [[7, 14]],
    );
    expect(parts).toEqual([
      { text: 'return', color: 'var(--k)', fontStyle: undefined, mark: false },
      { text: ' ', color: 'var(--t)', fontStyle: undefined, mark: false },
      { text: 'ordered', color: 'var(--t)', fontStyle: undefined, mark: true },
      { text: ';', color: 'var(--t)', fontStyle: undefined, mark: false },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(text);
  });

  it('falls back to plain text when tokens do not match the line', () => {
    expect(segments('abc', [['xyz']], [])).toEqual([
      { text: 'abc', color: undefined, fontStyle: undefined, mark: false },
    ]);
    expect(segments('abc', null, [[1, 2]]).map((p) => [p.text, p.mark])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ]);
  });
});

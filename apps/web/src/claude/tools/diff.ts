import { diffLines, diffWordsWithSpace } from 'diff';
import type { Token } from '../highlight.js';

/** A half-open character range `[start, end)` within a line. */
export type Range = readonly [start: number, end: number];

export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
  /** 1-based line numbers, null when the hunk's position in the file is unknown. */
  oldNo: number | null;
  newNo: number | null;
  /** Index into the hunk's old / new lines, for looking up syntax tokens. */
  oldIdx: number | null;
  newIdx: number | null;
  /** Changed words within a modified line. */
  marks: Range[];
}

export interface Hunk {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** The normalized texts the lines index into (highlight these). */
  oldText: string;
  newText: string;
}

/** Above this edit distance the diff gives up and shows old, then new. */
const MAX_EDIT_LENGTH = 2_000;
/** Word-level marks are skipped on long lines, and when most of a line changed. */
const MAX_MARK_LINE = 400;
const MIN_SHARED_RATIO = 0.4;
/** Blocks with more line pairs than this skip word marks. */
const MAX_PAIR_CHECKS = 400;

const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

function splitLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines;
}

function wordMarks(before: string, after: string): { del: Range[]; add: Range[] } | null {
  if (before.length > MAX_MARK_LINE || after.length > MAX_MARK_LINE) return null;
  const changes = diffWordsWithSpace(before, after);
  const del: Range[] = [];
  const add: Range[] = [];
  let o = 0;
  let n = 0;
  let shared = 0;
  for (const c of changes) {
    const len = c.value.length;
    if (c.added) {
      add.push([n, n + len]);
      n += len;
    } else if (c.removed) {
      del.push([o, o + len]);
      o += len;
    } else {
      shared += len;
      o += len;
      n += len;
    }
  }
  if (shared / Math.max(before.length, after.length, 1) < MIN_SHARED_RATIO) return null;
  return { del, add };
}

/**
 * A line diff of two texts, with changed words marked on lines that were modified rather than
 * replaced. `oldStart` / `newStart` number the lines; pass null when the position is unknown.
 */
export function buildHunk(
  before: string,
  after: string,
  oldStart: number | null = 1,
  newStart: number | null = oldStart,
): Hunk {
  const oldText = normalize(before);
  const newText = normalize(after);
  // Compare whole lines: a last line without its newline still matches the same line with one.
  const terminated = (t: string) => (t === '' || t.endsWith('\n') ? t : `${t}\n`);
  const changes = diffLines(terminated(oldText), terminated(newText), {
    maxEditLength: MAX_EDIT_LENGTH,
  }) ?? [
    { value: oldText, removed: true, added: false, count: 0 },
    { value: newText, removed: false, added: true, count: 0 },
  ];
  const lines: DiffLine[] = [];
  let oi = 0;
  let ni = 0;
  let added = 0;
  let removed = 0;
  const oldNo = (i: number) => (oldStart === null ? null : oldStart + i);
  const newNo = (i: number) => (newStart === null ? null : newStart + i);

  for (let c = 0; c < changes.length; c++) {
    const change = changes[c];
    if (!change) continue;
    if (!change.added && !change.removed) {
      for (const text of splitLines(change.value)) {
        lines.push({
          type: 'ctx',
          text,
          oldNo: oldNo(oi),
          newNo: newNo(ni),
          oldIdx: oi++,
          newIdx: ni++,
          marks: [],
        });
      }
      continue;
    }
    // A removal directly followed by an addition is a modification: pair the lines up.
    const dels = change.removed ? splitLines(change.value) : [];
    const next = change.removed ? changes[c + 1] : undefined;
    const adds = change.added
      ? splitLines(change.value)
      : next?.added
        ? splitLines(next.value)
        : [];
    if (next?.added) c++;
    // Each removed line pairs with the next added line similar enough to be its edit.
    const delMarks: Range[][] = [];
    const addMarks: Range[][] = [];
    let cursor = 0;
    if (dels.length * adds.length <= MAX_PAIR_CHECKS) {
      dels.forEach((del, i) => {
        for (let k = cursor; k < adds.length; k++) {
          const m = wordMarks(del, adds[k] as string);
          if (!m) continue;
          delMarks[i] = m.del;
          addMarks[k] = m.add;
          cursor = k + 1;
          break;
        }
      });
    }
    dels.forEach((text, i) => {
      lines.push({
        type: 'del',
        text,
        oldNo: oldNo(oi),
        newNo: null,
        oldIdx: oi++,
        newIdx: null,
        marks: delMarks[i] ?? [],
      });
    });
    adds.forEach((text, i) => {
      lines.push({
        type: 'add',
        text,
        oldNo: null,
        newNo: newNo(ni),
        oldIdx: null,
        newIdx: ni++,
        marks: addMarks[i] ?? [],
      });
    });
    removed += dels.length;
    added += adds.length;
  }
  return { lines, added, removed, oldText, newText };
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Side-by-side rows: context on both sides, removals left and additions right, paired up. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as DiffLine;
    if (line.type === 'ctx') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && (lines[i] as DiffLine).type === 'del')
      dels.push(lines[i++] as DiffLine);
    while (i < lines.length && (lines[i] as DiffLine).type === 'add')
      adds.push(lines[i++] as DiffLine);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

export interface Segment {
  text: string;
  color?: string;
  fontStyle?: number;
  mark: boolean;
}

/**
 * Cuts a line into styled pieces: syntax tokens (when they match the line) split further at the
 * edges of changed-word ranges.
 */
export function segments(
  text: string,
  tokens: readonly Token[] | null | undefined,
  marks: readonly Range[],
): Segment[] {
  const base: Token[] =
    tokens && tokens.map((t) => t[0]).join('') === text ? [...tokens] : [[text]];
  if (marks.length === 0) {
    return base.map(([t, color, fontStyle]) => ({ text: t, color, fontStyle, mark: false }));
  }
  const out: Segment[] = [];
  let pos = 0;
  for (const [content, color, fontStyle] of base) {
    const end = pos + content.length;
    let cut = pos;
    while (cut < end) {
      const inside = marks.find(([s, e]) => s <= cut && cut < e);
      let stop = end;
      if (inside) {
        stop = Math.min(end, inside[1]);
      } else {
        for (const [s] of marks) if (s > cut && s < stop) stop = s;
      }
      out.push({ text: content.slice(cut - pos, stop - pos), color, fontStyle, mark: !!inside });
      cut = stop;
    }
    pos = end;
  }
  return out;
}

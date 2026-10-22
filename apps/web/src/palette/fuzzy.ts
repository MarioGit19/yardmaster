/** A fuzzy match: higher scores rank first, `indices` are the matched characters of the text. */
export interface FuzzyMatch {
  score: number;
  indices: number[];
}

const MATCH = 1;
const WORD_START = 2;
const TEXT_START = 1;
const CONSECUTIVE = 1.5;
const GAP = 0.5;
const MIN_PER_CHAR = 1.5;

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** Bonus for matching at `i`: the start of the text, or of a word or camelCase hump. */
function startBonus(text: string, i: number): number {
  if (i === 0) return WORD_START + TEXT_START;
  const prev = text[i - 1] ?? '';
  const cur = text[i] ?? '';
  if (!isWordChar(prev) && isWordChar(cur)) return WORD_START;
  if (prev === prev.toLowerCase() && cur !== cur.toLowerCase()) return WORD_START;
  return 0;
}

/**
 * The best placement of `token`'s characters, in order, inside `text` (case-insensitive), or
 * null when they don't all appear. Word starts and runs score higher than scattered letters.
 */
function matchToken(token: string, text: string): FuzzyMatch | null {
  // Lowercased per UTF-16 unit, so indices stay aligned with `text`.
  const q = Array.from({ length: token.length }, (_, i) => (token[i] ?? '').toLowerCase());
  const t = Array.from({ length: text.length }, (_, i) => (text[i] ?? '').toLowerCase());
  const m = q.length;
  const n = t.length;
  if (m === 0) return { score: 0, indices: [] };
  if (m > n) return null;

  // at[i][j]: best score with q[i] matched at t[j]. upTo[i][j]: best with q[i] at or before j.
  const at: number[][] = [];
  const upTo: number[][] = [];
  const from: (number | null)[][] = [];
  for (let i = 0; i < m; i++) {
    const row = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
    const best = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
    const prev = new Array<number | null>(n).fill(null);
    for (let j = i; j < n; j++) {
      if (t[j] === q[i]) {
        const own = MATCH + startBonus(text, j);
        if (i === 0) {
          row[j] = own;
        } else {
          const run = (at[i - 1]?.[j - 1] ?? Number.NEGATIVE_INFINITY) + CONSECUTIVE;
          const jump = (upTo[i - 1]?.[j - 2] ?? Number.NEGATIVE_INFINITY) - GAP;
          if (run >= jump) {
            row[j] = own + run;
            prev[j] = j - 1;
          } else {
            row[j] = own + jump;
            prev[j] = -1;
          }
        }
      }
      best[j] = Math.max(
        row[j] ?? Number.NEGATIVE_INFINITY,
        best[j - 1] ?? Number.NEGATIVE_INFINITY,
      );
    }
    at.push(row);
    upTo.push(best);
    from.push(prev);
  }

  const last = at[m - 1] ?? [];
  let end = -1;
  let score = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < n; j++) {
    const value = last[j] ?? Number.NEGATIVE_INFINITY;
    if (value > score) {
      score = value;
      end = j;
    }
  }
  // Scattered single letters mid-word are noise: a word needs runs or word starts to count.
  if (end < 0 || score < m * MIN_PER_CHAR) return null;

  const indices = new Array<number>(m);
  let j = end;
  for (let i = m - 1; i >= 0; i--) {
    indices[i] = j;
    if (i === 0) break;
    const step = from[i]?.[j] ?? null;
    if (step === null) return null;
    if (step >= 0) {
      j = step;
    } else {
      // A jump: the previous character sits at the best position before j - 1.
      const before = at[i - 1] ?? [];
      const bound = upTo[i - 1]?.[j - 2] ?? Number.NEGATIVE_INFINITY;
      let k = j - 2;
      while (k >= 0 && before[k] !== bound) k--;
      if (k < 0) return null;
      j = k;
    }
  }
  return { score, indices };
}

/**
 * Matches every whitespace-separated word of `query` against `text`. Null when one word
 * doesn't match; an empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, indices: [] };
  let score = 0;
  const indices = new Set<number>();
  for (const token of tokens) {
    const match = matchToken(token, text);
    if (!match) return null;
    score += match.score;
    for (const i of match.indices) indices.add(i);
  }
  return { score, indices: [...indices].sort((a, b) => a - b) };
}

/** Splits `text` into runs, flagging the ones made of matched characters. */
export function highlightRuns(
  text: string,
  indices: readonly number[],
): { text: string; hit: boolean }[] {
  const hits = new Set(indices);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i] ?? '', hit });
  }
  return runs;
}

import { sparkLevel } from '../lanes/spark.js';
import { SAMPLES } from '../lanes/throughput.js';
import type { ActorKind, ActorState } from '../layouts/scene.js';
import type { Tone } from '../status.js';

// The Retro console's character grid (DESIGN.md §10.6): every frame, column and gap is a whole
// number of characters, so box drawing, tags and sparklines line up across the whole screen.

/** The narrowest frame: one project per row on a phone is still at least this wide (§10.1). */
export const FRAME_MIN = 40;
/** Frames grow with the screen up to this width, then more of them fit side by side. */
export const FRAME_MAX = 96;
/** Characters between two frames side by side; one empty line between rows of frames. */
export const GAP = 2;
/** Body lines per frame: fewer than this and a frame is a teaser, more and 20 won't fit. */
export const BODY_MIN = 3;
export const BODY_MAX = 8;
/** Below this width (px) the console stacks one frame per row, each actor on two lines. */
export const STACK_BELOW_PX = 600;

export interface ConsoleGrid {
  cols: number;
  /** Frame width in characters, borders included. */
  width: number;
}

/** As many frames per row as fit at `FRAME_MIN`, never more than there are projects. */
export function consoleGrid(chars: number, projects: number, stacked = false): ConsoleGrid {
  const room = Math.max(FRAME_MIN, Math.floor(chars));
  const fit = stacked ? 1 : Math.max(1, Math.floor((room + GAP) / (FRAME_MIN + GAP)));
  const cols = Math.min(fit, Math.max(1, projects));
  const width = Math.min(stacked ? room : FRAME_MAX, Math.floor((room - GAP * (cols - 1)) / cols));
  return { cols, width };
}

/**
 * Actor lines per frame, the same for every frame so the rows stay on the grid: enough for the
 * busiest project, but no more than lets every row of frames fit in `lines` of screen.
 */
export function bodyLines(maxActors: number, rows: number, lines: number): number {
  const want = Math.max(1, maxActors);
  // A row of frames is its body, two borders and the gap line below it.
  const fit = Math.floor((lines + 1) / Math.max(1, rows)) - 3;
  const cap = Math.min(BODY_MAX, Math.max(BODY_MIN, fit));
  return Math.min(want, cap);
}

/** Exactly `width` characters: clipped with "…" or padded with spaces (by code point). */
export function fit(text: string, width: number, pad = ' '): string {
  if (width <= 0) return '';
  const chars = Array.from(text.replace(/\s+/g, ' '));
  if (chars.length > width) return `${chars.slice(0, width - 1).join('')}…`;
  return chars.join('') + pad.repeat(width - chars.length);
}

export const TAG_WIDTH = 6;

const STATE_TAG: Record<ActorState, string> = {
  thinking: 'RUN',
  typing: 'RUN',
  reading: 'RUN',
  running: 'RUN',
  delegating: 'RUN',
  waiting: 'WAIT',
  error: 'ERR',
  serving: 'SERV',
  done: 'DONE',
  watching: 'IDLE',
  idle: 'IDLE',
  sleeping: 'ZZZ',
  exited: 'EXIT',
};

const TONE_TAG: Record<Tone, string> = {
  work: 'RUN',
  tool: 'RUN',
  wait: 'WAIT',
  err: 'ERR',
  ok: 'OK',
  idle: 'IDLE',
};

/** `[WAIT]`, the status in words (§8), padded to `TAG_WIDTH`. */
export const actorTag = (state: ActorState) => fit(`[${STATE_TAG[state]}]`, TAG_WIDTH);
export const projectTag = (tone: Tone) => `[${TONE_TAG[tone]}]`;

/** Working actors carry the blinking block cursor. */
export const isBusy = (tone: Tone) => tone === 'work' || tone === 'tool';

/** One character per kind, all in Geist Mono so the column holds: `»` Claude, `$` a shell. */
export const KIND_GLYPH: Record<ActorKind, string> = {
  claude: '»',
  subagent: '›',
  background: '&',
  terminal: '$',
};

export interface RowColumns {
  /** `[n]`, as wide as the frame's largest number. */
  num: number;
  label: number;
  /** 0 when the frame is too narrow for a per-actor sparkline. */
  spark: number;
  caption: number;
}

/** Below this inner width the actor rows drop their sparkline for a longer caption. */
const SPARK_FROM = 48;
export const ACTOR_SPARK = 6;
export const PROJECT_SPARK = 8;

/**
 * Columns of an actor row inside a frame `inner` characters wide (between `│ ` and ` │`):
 * `[n] » label  [TAG]  ▁▂▃▅▇▆  caption█`. The caption keeps one cell for the cursor.
 */
export function rowColumns(inner: number, actors: number): RowColumns {
  const num = `[${Math.max(1, actors)}]`.length;
  const label = Math.min(18, Math.max(8, Math.floor(inner * 0.22)));
  const spark = inner >= SPARK_FROM ? ACTOR_SPARK : 0;
  const fixed = num + 1 + 1 + 1 + label + 1 + TAG_WIDTH + 1 + (spark ? spark + 1 : 0) + 1;
  return { num, label, spark, caption: Math.max(1, inner - fixed) };
}

const BARS = '▁▂▃▄▅▆▇█';

/** A ring of samples, oldest first (`lanes/throughput.ts`). */
export interface Samples {
  at(i: number): number;
}

/**
 * An ASCII sparkline `width` characters long of the newest samples of every ring added together,
 * each character the sum of `per` samples, on the lanes' log scale (`lanes/spark.ts`).
 */
export function asciiSpark(rings: readonly Samples[], width: number, per = 4): string {
  const buckets = new Array<number>(width).fill(0);
  const span = Math.min(SAMPLES, width * per);
  for (const ring of rings) {
    for (let age = 0; age < span; age++) {
      const bucket = width - 1 - Math.floor(age / per);
      buckets[bucket] = (buckets[bucket] ?? 0) + ring.at(SAMPLES - 1 - age);
    }
  }
  const peak = Math.max(0, ...buckets);
  return buckets
    .map((value) => {
      if (value <= 0) return BARS[0];
      const level = sparkLevel(value / per, peak / per);
      return BARS[Math.min(BARS.length - 1, 1 + Math.round(level * (BARS.length - 2)))];
    })
    .join('');
}

export const FLAT_SPARK = (width: number) => BARS[0]?.repeat(width) ?? '';

/**
 * A typed number shortcut (§10.6) against `count` targets numbered from 1. `index` is where it
 * points now (0-based, or null), `pending` whether another digit could still make it a larger
 * number ("1" of 20 waits for "12").
 */
export function pickNumber(
  buffer: string,
  count: number,
): { index: number | null; pending: boolean } {
  if (!/^\d+$/.test(buffer)) return { index: null, pending: false };
  const n = Number(buffer);
  const valid = n >= 1 && n <= count;
  return { index: valid ? n - 1 : null, pending: n >= 1 && n * 10 <= count };
}

/** How long a number shortcut waits for its next digit. */
export const NUMBER_WAIT_MS = 700;

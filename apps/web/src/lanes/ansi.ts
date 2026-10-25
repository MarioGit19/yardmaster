// A small terminal tail for the lane peek (DESIGN.md §4.3): keeps the last few lines of a
// stream as styled segments. Understands SGR colors, CR/LF and backspace; every other escape
// sequence is dropped. Escapes split across chunks are carried over.

/** Status and text tokens for the 8 basic colors (the AA ink tones); bright variants share them. */
const COLORS = [
  'var(--text-3)', // black
  'var(--st-err-ink)', // red
  'var(--st-ok-ink)', // green
  'var(--st-wait-ink)', // yellow
  'var(--st-work-ink)', // blue
  'var(--orb-edit-ink)', // magenta
  'var(--st-tool-ink)', // cyan
  'var(--text-1)', // white
] as const;

export interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface Segment {
  text: string;
  style: Style;
}

export type Line = Segment[];

const PLAIN: Style = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
};

/** Big backlogs are cut to their last few KB before parsing; colors may restart there. */
const MAX_PARSE = 16_384;
/** A line longer than this is cut, so a stream without newlines can't grow forever. */
const MAX_LINE = 1_000;

const sameStyle = (a: Style, b: Style) =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  a.bold === b.bold &&
  a.dim === b.dim &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.inverse === b.inverse;

/** xterm 256-color index → CSS: the 16 basics map to tokens, the rest are computed. */
function color256(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return COLORS[n % 8] ?? null;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v} ${v} ${v})`;
  }
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(i / 36))} ${level(Math.floor(i / 6) % 6)} ${level(i % 6)})`;
}

/** Applies one SGR parameter list (`1;31`, `38;5;208`, …) to `style`. */
export function applySgr(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  const next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0;
    if (code === 0) Object.assign(next, PLAIN);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) next.bold = next.dim = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = COLORS[code - 30] ?? null;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = COLORS[code - 40] ?? null;
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97) next.fg = COLORS[code - 90] ?? null;
    else if (code >= 100 && code <= 107) next.bg = COLORS[code - 100] ?? null;
    else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      let value: string | null = null;
      if (mode === 5) {
        value = color256(codes[i + 2] ?? -1);
        i += 2;
      } else if (mode === 2) {
        const [r = 0, g = 0, b = 0] = codes.slice(i + 2, i + 5).map((c) => Math.min(255, c));
        value = `rgb(${r} ${g} ${b})`;
        i += 4;
      }
      if (code === 38) next.fg = value;
      else next.bg = value;
    }
  }
  return next;
}

// CSI (ESC [ … final), OSC (ESC ] … BEL or ESC \), other two-byte escapes, then C0 controls.
const TOKEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control bytes is the point.
  /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b[ -/]+[0-~]|([\r\n\b\t])|[\x00-\x08\x0b-\x1f\x7f]/g;
// An escape cut off at the end of a chunk.
// biome-ignore lint/suspicious/noControlCharactersInRegex: same as above.
const PARTIAL = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[ -/]*)?$/;

/** Keeps the last `size` lines of a terminal stream, plus the line being written. */
export class TerminalTail {
  private lines: Line[] = [];
  private current: Line = [];
  private style: Style = PLAIN;
  private carry = '';
  /** A CR waits for the next byte: before LF it ends the line, before text it rewinds. */
  private pendingCr = false;
  /** Bumps on every change, so callers can skip work when nothing arrived. */
  version = 0;

  constructor(private readonly size = 6) {}

  feed(chunk: string): void {
    if (chunk === '') return;
    let text = this.carry + chunk;
    this.carry = '';
    if (text.length > MAX_PARSE) {
      const cut = text.lastIndexOf('\n', text.length - MAX_PARSE);
      text = text.slice(cut === -1 ? text.length - MAX_PARSE : cut + 1);
    }
    const partial = PARTIAL.exec(text);
    if (partial && partial[0].length < 256) {
      this.carry = partial[0];
      text = text.slice(0, partial.index);
    }

    let last = 0;
    TOKEN.lastIndex = 0;
    for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
      this.write(text.slice(last, match.index));
      last = TOKEN.lastIndex;
      const [, params, final, control] = match;
      if (final === 'm') this.style = applySgr(this.style, params ?? '');
      else if (control === '\n') this.newline();
      else if (control === '\r') this.pendingCr = true;
      else if (control === '\t') this.write('  ');
      else if (control === '\b') this.backspace();
    }
    this.write(text.slice(last));
    this.version++;
  }

  /** The finished lines plus the open one (when it has text), oldest first. */
  snapshot(): Line[] {
    const open = this.current.length > 0 ? [this.current] : [];
    return [...this.lines, ...open].slice(-this.size);
  }

  private write(text: string): void {
    if (text === '') return;
    if (this.pendingCr) {
      this.pendingCr = false;
      this.current = [];
    }
    const length = this.current.reduce((n, s) => n + s.text.length, 0);
    const room = MAX_LINE - length;
    if (room <= 0) return;
    const clipped = text.length > room ? text.slice(0, room) : text;
    const tail = this.current.at(-1);
    if (tail && sameStyle(tail.style, this.style)) tail.text += clipped;
    else this.current.push({ text: clipped, style: this.style });
  }

  private newline(): void {
    this.pendingCr = false;
    this.lines.push(this.current);
    this.current = [];
    if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size);
  }

  private backspace(): void {
    if (this.pendingCr) return;
    const tail = this.current.at(-1);
    if (!tail) return;
    tail.text = tail.text.slice(0, -1);
    if (tail.text === '') this.current.pop();
  }
}

/** Inline CSS for a segment; inverse swaps the colors. */
export function segmentCss(style: Style): React.CSSProperties | undefined {
  if (sameStyle(style, PLAIN)) return undefined;
  let fg = style.inverse ? (style.bg ?? 'var(--bg-1)') : style.fg;
  const bg = style.inverse ? (style.fg ?? 'var(--text-1)') : style.bg;
  // Default or black text on a colored background (a test runner's PASS badge) takes the page
  // color: dark on the dark theme's bright tones, white on the light theme's deep inks.
  if (bg && (fg === null || fg === COLORS[0])) fg = 'var(--bg-1)';
  // Dim is the quiet text color rather than a fade, which would drop it below AA.
  if (style.dim && fg === null) fg = 'var(--text-3)';
  return {
    color: fg ?? undefined,
    backgroundColor: bg ?? undefined,
    fontWeight: style.bold ? 600 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration: style.underline ? 'underline' : undefined,
  };
}

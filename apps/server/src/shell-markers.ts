/**
 * Shell integration markers in a board terminal's pty stream: FinalTerm's OSC 133
 * (`A` prompt, `B` input, `C` command runs, `D;<code>` it ended), VS Code's OSC 633 (the same
 * letters, plus `E;<command line>;<nonce>` and `P;Cwd=<dir>;<nonce>`) and OSC 7
 * (`file://host/dir;<nonce>`).
 *
 * Anything a terminal prints can contain these sequences (`cat` a hostile README), so the ones
 * that carry data need the terminal's nonce, which only our shell integration knows.
 * Without it they are dropped, and a terminal without a nonce takes none of them.
 */
export type ShellMarker =
  | { kind: 'prompt' }
  | { kind: 'input' }
  | { kind: 'executed' }
  | { kind: 'finished'; exitCode: number | null }
  | { kind: 'commandLine'; commandLine: string }
  | { kind: 'cwd'; cwd: string };

export type ShellToken = { text: string } | { marker: ShellMarker };

export interface MarkerParser {
  /** Splits `chunk` into text and markers, in stream order. Marker bytes never reach the text. */
  push(chunk: string): ShellToken[];
  /** Releases text held back as a possible marker start (end of stream). */
  flush(): string;
}

/** How a board terminal's shell gets its nonce. The shell integration unsets it at once. */
export const MARKER_NONCE_ENV = 'YARDMASTER_NONCE';

const OURS = new Set(['7', '133', '633']);
/** An unterminated sequence longer than this isn't a marker; it goes out as text. */
const MAX_SEQUENCE = 8 * 1024;

/** Undoes the shell side's escaping: `\\` is a backslash, `\xNN` a byte (`;` and controls). */
export function unescapeMarkerValue(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_, escaped: string, hex?: string) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : escaped,
  );
}

function fileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    return decodeURIComponent(url.pathname) || null;
  } catch {
    return null;
  }
}

/**
 * The marker an OSC payload (`133;D;0`, without `ESC ]` and the terminator) carries, if any.
 * `nonce` is the terminal's: a command line or cwd without it is no marker.
 */
export function parseMarker(payload: string, nonce: string | null): ShellMarker | null {
  const semi = payload.indexOf(';');
  const code = semi === -1 ? payload : payload.slice(0, semi);
  const rest = semi === -1 ? '' : payload.slice(semi + 1);
  const signed = (value: string | undefined) => Boolean(nonce) && value === nonce;
  if (code === '7') {
    const end = rest.lastIndexOf(';');
    if (end === -1 || !signed(rest.slice(end + 1))) return null;
    const cwd = fileUrlPath(rest.slice(0, end));
    return cwd ? { kind: 'cwd', cwd } : null;
  }
  if (code !== '133' && code !== '633') return null;
  const [letter = '', ...args] = rest.split(';');
  switch (letter) {
    case 'A':
      return { kind: 'prompt' };
    case 'B':
      return { kind: 'input' };
    case 'C':
      return { kind: 'executed' };
    case 'D': {
      const exitCode = args[0] !== undefined && /^\d+$/.test(args[0]) ? Number(args[0]) : null;
      return { kind: 'finished', exitCode };
    }
    case 'E':
      // The command line is escaped, so its own `;` never splits it.
      return code === '633' && args.length === 2 && signed(args[1])
        ? { kind: 'commandLine', commandLine: unescapeMarkerValue(args[0] ?? '') }
        : null;
    case 'P': {
      const property = args[0] ?? '';
      if (code !== '633' || !property.startsWith('Cwd=')) return null;
      if (args.length !== 2 || !signed(args[1])) return null;
      const cwd = unescapeMarkerValue(property.slice(4));
      return cwd ? { kind: 'cwd', cwd } : null;
    }
    default:
      return null;
  }
}

/**
 * A stateful splitter for a pty stream. Sequences may be split anywhere across chunks, so a
 * partial one is carried over to the next push. Every OSC 7/133/633 sequence is removed from the
 * text (unknown letters and unsigned ones too); other escape sequences pass through untouched.
 */
export function createMarkerParser(nonce: string | null): MarkerParser {
  let carry = '';

  return {
    push(chunk) {
      const text = carry + chunk;
      carry = '';
      const tokens: ShellToken[] = [];
      let out = '';
      let i = 0;

      const emitText = () => {
        if (out !== '') tokens.push({ text: out });
        out = '';
      };

      while (i < text.length) {
        const esc = text.indexOf('\x1b', i);
        if (esc === -1) {
          out += text.slice(i);
          break;
        }
        out += text.slice(i, esc);
        // `ESC ] <digits> ;` decides whether the sequence is ours.
        let j = esc + 1;
        if (j >= text.length) {
          carry = text.slice(esc);
          break;
        }
        if (text[j] !== ']') {
          out += '\x1b';
          i = j;
          continue;
        }
        j++;
        while (
          j < text.length &&
          j - esc < 8 &&
          text.charCodeAt(j) >= 48 &&
          text.charCodeAt(j) <= 57
        ) {
          j++;
        }
        if (j >= text.length) {
          carry = text.slice(esc);
          break;
        }
        const code = text.slice(esc + 2, j);
        if (!OURS.has(code) || (text[j] !== ';' && text[j] !== '\x07' && text[j] !== '\x1b')) {
          out += text.slice(esc, j);
          i = j;
          continue;
        }
        const bel = text.indexOf('\x07', j);
        const st = text.indexOf('\x1b\\', j);
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
        if (end === -1) {
          if (text.length - esc > MAX_SEQUENCE) {
            out += text.slice(esc);
            break;
          }
          carry = text.slice(esc);
          break;
        }
        const marker = parseMarker(text.slice(esc + 2, end), nonce);
        if (marker) {
          emitText();
          tokens.push({ marker });
        }
        i = end + (end === bel ? 1 : 2);
      }
      emitText();
      return tokens;
    },
    flush() {
      const rest = carry;
      carry = '';
      return rest;
    },
  };
}

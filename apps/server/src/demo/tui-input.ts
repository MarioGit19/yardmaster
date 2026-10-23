const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** A write this long arrives as a burst, which Claude Code's TUI reads as a paste. */
export const TUI_PASTE_MIN = 32;

/** What one terminal write did to Claude Code's prompt. */
export interface TuiInput {
  /** The prompt's text after the write. */
  buffer: string;
  /** Prompts submitted by this write, in order. */
  submitted: string[];
  /** What the TUI echoes, with line breaks as `\r\n`. */
  echo: string;
}

/**
 * A model of how Claude Code's prompt reads input: bracketed paste is inserted literally; a
 * burst (long text, or text with a line break before its last character) is a paste too, so an
 * Enter inside it is a newline; otherwise Enter submits and DEL erases. Used by the demo terminals
 * and the terminal-reply tests.
 */
export function readTuiInput(buffer: string, data: string): TuiInput {
  const result: TuiInput = { buffer, submitted: [], echo: '' };
  let rest = data;
  while (rest !== '') {
    const start = rest.indexOf(PASTE_START);
    if (start === -1) {
      keys(result, rest);
      break;
    }
    keys(result, rest.slice(0, start));
    const body = rest.slice(start + PASTE_START.length);
    const end = body.indexOf(PASTE_END);
    insert(result, end === -1 ? body : body.slice(0, end));
    rest = end === -1 ? '' : body.slice(end + PASTE_END.length);
  }
  return result;
}

function keys(result: TuiInput, keystrokes: string): void {
  // Esc, arrows and other escape sequences move or stop things; they type nothing.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point.
  const data = keystrokes.replace(/\x1b(\[[0-9;?]*[@-~]|.)?/g, '');
  const burst = data.length >= TUI_PASTE_MIN || /[\r\n]./.test(data);
  if (burst) {
    insert(result, data);
    return;
  }
  for (const char of data) {
    if (char === '\r' || char === '\n') {
      if (result.buffer.trim() !== '') result.submitted.push(result.buffer);
      result.buffer = '';
      result.echo += '\r\n';
    } else if (char === '\x7f' || char === '\b') {
      result.buffer = [...result.buffer].slice(0, -1).join('');
    } else if (char >= ' ') {
      result.buffer += char;
      result.echo += char;
    }
  }
}

function insert(result: TuiInput, text: string): void {
  const normalized = text.replace(/\r\n?/g, '\n');
  result.buffer += normalized;
  result.echo += normalized.replace(/\n/g, '\r\n');
}

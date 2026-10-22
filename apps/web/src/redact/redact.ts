/**
 * Secret masking for the UI (PRD §8.7). Masks keep a recognizable prefix (`sk-ant-`, `ghp_`,
 * `AKIA`, the variable name) and replace the secret itself with a fixed-length mask, so the
 * length doesn't leak either.
 */

export const MASK = '••••••••';

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*KEY-----/;
const PEM_BLOCK = new RegExp(
  `(${PEM_BEGIN.source})([\\s\\S]*?)(${PEM_END.source}|$(?![\\s\\S]))`,
  'g',
);
/** Masks each line of a key body, keeping the line breaks so a terminal keeps its rows. */
const maskLines = (body: string) => body.replace(/[^\r\n]+/g, MASK);

const TOKENS: readonly [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, `sk-ant-${MASK}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}\b/g, `$1${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, `$1${MASK}`],
];

/** `NAME=value`, where the value is quoted or runs to whitespace or punctuation. */
const ASSIGNMENT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a value stops at an ANSI escape
  /\b([A-Z_][A-Z0-9_]*)([ \t]*=[ \t]*)(?!=)("[^"\n]*"|'[^'\n]*'|[^\s"'`;,)&|\x1b]+)/g;
/** The name has a segment ending in a secret-ish word: API_KEY, APIKEY, DB_PASSWORD, not KEYBOARD. */
const SECRET_NAME = /(?:^|_)[A-Z0-9]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD)(?:_|$)/;

function maskAssignment(match: string, name: string, eq: string, value: string): string {
  if (!SECRET_NAME.test(name)) return match;
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  const inner = quote ? value.slice(1, -1) : value;
  // Empty values and references to other variables hold no secret.
  if (inner === '' || inner.startsWith('$')) return match;
  return `${name}${eq}${quote}${MASK}${quote}`;
}

function maskTokens(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TOKENS) out = out.replace(pattern, replacement);
  return out.replace(ASSIGNMENT, maskAssignment);
}

interface Pass {
  text: string;
  /** Ends inside a key block that hasn't closed yet. */
  inKey: boolean;
}

function pass(text: string, inKey: boolean): Pass {
  let rest = text;
  let head = '';
  if (inKey) {
    const end = PEM_END.exec(rest);
    if (!end) return { text: maskLines(rest), inKey: true };
    head = maskLines(rest.slice(0, end.index));
    rest = rest.slice(end.index);
  }
  let open = false;
  const blocks = rest.replace(PEM_BLOCK, (_m, begin: string, body: string, end: string) => {
    if (end === '') open = true;
    return `${begin}${maskLines(body)}${end}`;
  });
  return { text: head + maskTokens(blocks), inKey: open };
}

/** Masks the secrets in a piece of text. Returns the same string when there are none. */
export function redact(text: string): string {
  const out = pass(text, false).text;
  return out === text ? text : out;
}

/**
 * Masks every string inside a JSON-like value (tool inputs). Unchanged parts keep their
 * identity, so a value without secrets comes back as the very same object.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const masked = redactDeep(item);
      if (masked !== item) changed = true;
      return masked;
    });
    return (changed ? next : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const masked = redactDeep(item);
      if (masked !== item) changed = true;
      next[key] = masked;
    }
    return (changed ? next : value) as T;
  }
  return value;
}

/** Text after the last line break, which the stream holds back until the line completes. */
const HOLD_MAX = 4_096;

/**
 * Masks a terminal stream chunk by chunk. A secret can be split across chunks, so the
 * unfinished last line is held back until its line break arrives, or until `flush()` (the
 * caller flushes on a short timer, so prompts and progress bars still show). A key block
 * spanning many chunks stays masked until its END line.
 */
export class StreamRedactor {
  private tail = '';
  private inKey = false;

  /** Feeds a chunk; returns what can be written now. */
  push(chunk: string): string {
    const text = this.tail + chunk;
    const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
    if (cut === 0 && text.length < HOLD_MAX) {
      this.tail = text;
      return '';
    }
    const ready = cut === 0 ? text : text.slice(0, cut);
    this.tail = cut === 0 ? '' : text.slice(cut);
    return this.run(ready);
  }

  /** Whether `push` is holding text back. */
  get pending(): boolean {
    return this.tail !== '';
  }

  /** Releases the held-back partial line. */
  flush(): string {
    const text = this.tail;
    this.tail = '';
    return text === '' ? '' : this.run(text);
  }

  private run(text: string): string {
    const result = pass(text, this.inKey);
    this.inKey = result.inKey;
    return result.text;
  }
}

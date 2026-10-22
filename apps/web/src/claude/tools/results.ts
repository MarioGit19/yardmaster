// Reading tool results: Claude Code returns plain text, so these pull out the few facts the
// cards show (exit codes, line numbers, file counts, links). Each returns null when unsure.

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)|[@-Z\\\\-_])`,
  'g',
);

export function stripAnsi(text: string): string {
  return text.includes(ESC) ? text.replace(ANSI, '') : text;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** The exit status of a Bash call: 0 on success, the reported code (or 1) on failure. */
export function bashExitCode(result: ToolResult | null): number | null {
  if (!result) return null;
  if (!result.isError) return 0;
  const match = /^(?:Error: )?Exit code (\d+)/m.exec(result.text);
  return match ? Number(match[1]) : 1;
}

/** Bash output without the "Exit code N" line Claude Code puts in front of failures. */
export function bashOutput(text: string): string {
  return stripAnsi(text.replace(/^(?:Error: )?Exit code \d+\n?/, '')).replace(/\s+$/, '');
}

export interface NumberedLine {
  no: number;
  text: string;
}

const NUMBERED = /^\s*(\d+)(?:\t|→)(.*)$/;

/** Lines of `cat -n` style output (Read results, edit snippets), or null if it isn't that. */
export function numberedLines(text: string): NumberedLine[] | null {
  const raw = text.replace(/\s+$/, '').split('\n');
  const lines: NumberedLine[] = [];
  for (const line of raw) {
    const m = NUMBERED.exec(line);
    if (m) lines.push({ no: Number(m[1]), text: m[2] ?? '' });
  }
  return lines.length > 0 && lines.length >= raw.length / 2 ? lines : null;
}

/**
 * Where an edit landed, from the numbered snippet Claude Code returns after editing: the line
 * number of the replacement's first non-blank line, minus the blank lines before it.
 */
export function editStartLine(resultText: string, newString: string): number | null {
  const snippet = numberedLines(resultText);
  if (!snippet) return null;
  const lines = newString.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return null;
  const needle = (lines[first] as string).trim();
  const hits = snippet.filter((l) => l.text.trim() === needle);
  // Ambiguous (or absent): better no numbers than wrong ones.
  if (hits.length !== 1) return null;
  const start = (hits[0] as NumberedLine).no - first;
  return start >= 1 ? start : null;
}

const nonEmpty = (text: string) => text.split('\n').filter((l) => l.trim() !== '');

/** "12 files", "no matches" or "N lines" for a Grep result. */
export function grepCount(text: string): string | null {
  const found = /^Found (\d+) (files?|matches|lines?)/m.exec(text);
  if (found) return `${found[1]} ${found[2]}`;
  if (/^No (?:files|matches) found/m.test(text)) return 'no matches';
  const lines = nonEmpty(text).length;
  return lines > 0 ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : null;
}

/** File paths of a Glob or Grep (files) result. */
export function listedPaths(text: string): string[] {
  if (/^No files found/m.test(text)) return [];
  return nonEmpty(text).filter(
    (l) => !/^Found \d+ /.test(l) && !/^\(Results are truncated/.test(l),
  );
}

/** "3 files", "no files" for a Glob result. */
export function globCount(text: string): string {
  const n = listedPaths(text).length;
  return n === 0 ? 'no files' : `${n} ${n === 1 ? 'file' : 'files'}`;
}

/** "220 lines" or "lines 40–120" for a Read result. */
export function readExtent(text: string): string | null {
  const lines = numberedLines(text);
  if (!lines) return null;
  const first = (lines[0] as NumberedLine).no;
  const last = (lines[lines.length - 1] as NumberedLine).no;
  return first > 1
    ? `lines ${first}–${last}`
    : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`;
}

/** Distinct http(s) URLs in a result, in order. */
export function urlsIn(text: string, max = 8): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]}]+/g)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    seen.add(url);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** Host and the rest of a URL, for chips; null for anything that isn't http(s). */
export function urlParts(url: string): { host: string; rest: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    return { host: u.host.replace(/^www\./, ''), rest };
  } catch {
    return null;
  }
}

/** `mcp__tracker__create_ticket` → "tracker · create_ticket"; other names unchanged. */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** A path relative to `cwd` when inside it, split into directory and file name. */
export function pathParts(path: string, cwd?: string): { dir: string; base: string } {
  const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  const cut = rel.lastIndexOf('/', rel.length - 2);
  return cut < 0
    ? { dir: '', base: rel }
    : { dir: rel.slice(0, cut + 1), base: rel.slice(cut + 1) };
}

/** Pretty JSON for the generic card; anything unserializable shows as its string form. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The extension of a path, for picking a grammar. */
export function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : null;
}

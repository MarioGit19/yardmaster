import type { ClaudeSession, Terminal } from './domain.js';

// What terminals and Claude sessions are called on screen. Editors and Claude Code name
// things automatically (`zsh`, `yardmaster-c3`); a name the user gave always wins.

export type SessionNameFields = Pick<ClaudeSession, 'title'> &
  Partial<Pick<ClaudeSession, 'customTitle' | 'ordinal'>>;

export const CLAUDE_NAME = 'Claude';
/** Longest command shown in place of an automatic terminal name. */
export const COMMAND_NAME_MAX = 32;

const AUTOMATIC_TERMINAL_NAMES = new Set([
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
  'pwsh',
  'powershell',
  'cmd',
  'login',
  'tmux',
  'screen',
  'ssh',
  'node',
  'python',
  'python3',
  'ruby',
  'deno',
  'bun',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'claude',
  'terminal',
]);

/** Claude Code titles its terminal with a spinner glyph ("✳ Fix the cart"). */
const CLAUDE_TITLE = /^(?:[✳✶✻✽✢·*⠀-⣿]\s|claude code\b)/iu;

const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? '';

/** A shell or process name the editor picked, rather than one the user typed. */
export function isAutomaticTerminalName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === '' || CLAUDE_TITLE.test(trimmed)) return true;
  const process = basename(trimmed.replace(/\s*\(\d+\)$/, ''))
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/^-/, '');
  return AUTOMATIC_TERMINAL_NAMES.has(process) || /^python\d+(\.\d+)?$/.test(process);
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Claude Code's own `<folder>-<code>` session name, e.g. `acme-shop-c3` in `/home/dev/acme-shop`. */
export function isAutomaticSessionName(name: string, cwd: string | null | undefined): boolean {
  const folder = cwd ? slug(basename(cwd)) : '';
  if (folder === '') return false;
  const value = slug(name);
  return value.startsWith(`${folder}-`) && /^[a-z0-9]{1,8}$/.test(value.slice(folder.length + 1));
}

/** "Claude", "Claude 2"…, or the name the user gave it. */
export function sessionDisplayName(session: SessionNameFields): string {
  const custom = session.customTitle?.trim();
  if (custom) return custom;
  const n = session.ordinal ?? 1;
  return n > 1 ? `${CLAUDE_NAME} ${n}` : CLAUDE_NAME;
}

/** The automatic name or summary, for a tooltip or subtitle; null when it adds nothing. */
export function sessionSubtitle(session: SessionNameFields): string | null {
  const title = session.title?.trim();
  return title && title !== sessionDisplayName(session) ? title : null;
}

/**
 * The lowest number no other live unnamed session of the project holds. Ended sessions keep
 * their number but no longer hold it.
 */
export function nextSessionOrdinal(
  sessions: Iterable<
    Pick<ClaudeSession, 'id' | 'projectId' | 'status'> &
      Partial<Pick<ClaudeSession, 'customTitle' | 'ordinal'>>
  >,
  session: Pick<ClaudeSession, 'id' | 'projectId'>,
): number {
  const taken = new Set<number>();
  for (const other of sessions) {
    if (other.id === session.id || other.projectId !== session.projectId) continue;
    if (other.status.kind === 'ended' || other.customTitle?.trim() || !other.ordinal) continue;
    taken.add(other.ordinal);
  }
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

export interface TerminalNameContext {
  /** The running command, if any. */
  running?: string | null;
  /** The last command the terminal ran. */
  last?: string | null;
  /** The live Claude session running in it (10.9). */
  session?: SessionNameFields | null;
}

export interface TerminalDisplayName {
  name: string;
  /** The editor's own name when it was replaced, for a tooltip; null when shown as is. */
  raw: string | null;
}

function commandName(command: string | null | undefined): string | null {
  const line = command?.split('\n')[0]?.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > COMMAND_NAME_MAX ? `${line.slice(0, COMMAND_NAME_MAX - 1)}…` : line;
}

/**
 * A user-given name as is. An automatic one becomes the Claude session's name, else the
 * running command, else the last one, else the folder plus shell (`storefront · zsh`).
 */
export function terminalDisplayName(
  terminal: Pick<Terminal, 'name' | 'cwd'>,
  context: TerminalNameContext = {},
): TerminalDisplayName {
  const raw = terminal.name.trim();
  if (!isAutomaticTerminalName(raw)) return { name: raw, raw: null };
  const name =
    (context.session ? sessionDisplayName(context.session) : null) ??
    commandName(context.running) ??
    commandName(context.last) ??
    folderName(raw, terminal.cwd);
  return { name, raw: raw && raw !== name ? raw : null };
}

function folderName(raw: string, cwd: string | null): string {
  const folder = cwd ? basename(cwd) : '';
  if (!raw) return folder || 'Terminal';
  return folder ? `${folder} · ${raw}` : raw;
}

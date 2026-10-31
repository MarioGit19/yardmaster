import type { Terminal } from '@yardmaster/protocol';
import { createPreference } from '../prefs.js';

export const STACK_LAYOUTS = ['tabs', 'grid'] as const;
export type StackLayout = (typeof STACK_LAYOUTS)[number];

/** Tabs or the 2×2 grid, the same for every project. */
export const stackLayoutPreference = createPreference<StackLayout>(
  'yardmaster.terminals.layout',
  STACK_LAYOUTS,
  'tabs',
);

/** The 2×2 grid. */
export const GRID_MAX = 4;
/** Closed terminals stay as tabs (their output is still worth reading), the newest few. */
export const MAX_CLOSED_TABS = 4;

type StackTerminal = Pick<Terminal, 'id' | 'state' | 'createdAt' | 'closedAt' | 'active'>;

/** Open terminals in creation order, then the most recently closed ones. */
export function stackOrder<T extends StackTerminal>(terminals: readonly T[]): T[] {
  const open = terminals
    .filter((t) => t.state === 'open')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const closed = terminals
    .filter((t) => t.state === 'closed')
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_CLOSED_TABS);
  return [...open, ...closed];
}

/**
 * The chosen tab if it still exists. Without a choice: the editor's active terminal, else the
 * first, preferring ones the stack can mirror (`mirrorable`) over an interactive app's pane.
 */
export function resolveActive(
  ordered: readonly StackTerminal[],
  chosen: string | null,
  mirrorable: (id: string) => boolean = () => true,
): string | null {
  if (chosen !== null && ordered.some((t) => t.id === chosen)) return chosen;
  const editorActive = (t: StackTerminal) => t.active && t.state === 'open';
  return (
    (
      ordered.find((t) => editorActive(t) && mirrorable(t.id)) ??
      ordered.find((t) => mirrorable(t.id)) ??
      ordered.find(editorActive) ??
      ordered[0]
    )?.id ?? null
  );
}

/** Up to four terminals for the grid, always including the active one. */
export function gridTerminals<T extends StackTerminal>(
  ordered: readonly T[],
  activeId: string | null,
): T[] {
  const first = ordered.slice(0, GRID_MAX);
  if (activeId === null || first.some((t) => t.id === activeId)) return first;
  const active = ordered.find((t) => t.id === activeId);
  return active ? [...first.slice(0, GRID_MAX - 1), active] : first;
}

/** What a terminal's pane shows. */
export type PaneKind = 'xterm' | 'interactive';

/**
 * A running alt-screen app (claude, htop, vim) redraws the screen in place, which a mirror of
 * its byte stream can't reproduce, so its pane points to the editor instead.
 */
export function paneKind(
  execution: { interactive: boolean; endedAt: number | null } | null,
  terminal: Pick<Terminal, 'state'>,
): PaneKind {
  return execution?.interactive && execution.endedAt === null && terminal.state === 'open'
    ? 'interactive'
    : 'xterm';
}

/** Keyboard: the tab after (or before) `id`, wrapping around. */
export function stepTab(ordered: readonly { id: string }[], id: string | null, step: 1 | -1) {
  if (ordered.length === 0) return null;
  const index = ordered.findIndex((t) => t.id === id);
  const next = index < 0 ? 0 : (index + step + ordered.length) % ordered.length;
  return ordered[next]?.id ?? null;
}

const ERRORS: Record<string, string> = {
  editor_offline: 'The editor window is offline',
  editor_timeout: 'The editor did not answer',
  editor_disconnected: 'The editor disconnected',
  no_editor: 'No editor window has this terminal',
  terminal_closed: 'The terminal is closed',
  unknown_terminal: 'The terminal is gone',
  unknown_execution: 'That run is no longer known to the editor',
  nothing_to_rerun: 'Nothing to re-run',
  unsafe_command_line: 'That command line has control characters, so it is not run again',
  offline: 'Yardmaster is offline',
  disconnected: 'Yardmaster is offline',
  timeout: 'No answer from Yardmaster',
  not_implemented: 'Not available yet',
  outside_library: 'That folder is not in your project library',
  unknown_project: 'That project is no longer on the board',
  folder_untrusted: 'Not started: the folder is not trusted',
  trust_changed: 'The folder’s Claude settings changed. Review them again',
  window_not_closed: 'The editor window did not close',
  editor_not_found:
    'No Cursor or VS Code command line found. Install its shell command, or set its path in Settings',
  editor_launch_failed: 'The editor could not be started',
  pty_unavailable: 'Board terminals are off: node-pty did not load (see yardmaster doctor)',
  too_many_terminals: 'Already 16 board terminals running. End one first',
  pty_spawn_failed: 'The shell could not be started',
  review_changed: 'The files changed since this review. Look at the new diff first',
  nothing_to_commit: 'Nothing to commit',
  commit_conflicts: 'Resolve the conflicts before committing',
  commit_failed: 'Git refused the commit',
  not_discardable: 'That file has nothing to discard',
  discard_failed: 'Git could not discard that file',
  config_runs_commands: 'Skipped: this repository’s config runs commands',
  no_worktree_flag: 'This version of Claude Code has no --worktree option',
};

/** A server error code as a sentence for a toast. */
export function actionErrorText(code: string, fallback = 'The terminal command failed'): string {
  return ERRORS[code] ?? fallback;
}

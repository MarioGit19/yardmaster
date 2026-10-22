import type { Terminal } from '@c-board/protocol';
import { createPreference } from '../prefs.js';

export const STACK_LAYOUTS = ['tabs', 'grid'] as const;
export type StackLayout = (typeof STACK_LAYOUTS)[number];

/** Tabs or the 2×2 grid, the same for every project. */
export const stackLayoutPreference = createPreference<StackLayout>(
  'cboard.terminals.layout',
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

/** The chosen tab if it still exists, else the editor's active terminal, else the first. */
export function resolveActive(
  ordered: readonly StackTerminal[],
  chosen: string | null,
): string | null {
  if (chosen !== null && ordered.some((t) => t.id === chosen)) return chosen;
  return (ordered.find((t) => t.active && t.state === 'open') ?? ordered[0])?.id ?? null;
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
  offline: 'c-board is offline',
  disconnected: 'c-board is offline',
  timeout: 'No answer from c-board',
};

/** A server error code as a sentence for a toast. */
export function actionErrorText(code: string): string {
  return ERRORS[code] ?? 'The terminal command failed';
}

import type { BoardState } from '@yardmaster/protocol';

// The active-only overview (F26): which projects the overview shows. Everything else stays on
// the board (the rail, ⌘K, the picker's recents); it just isn't drawn in the layouts.

export interface ActiveRule {
  now: number;
  /** `library.idleHideMin` in ms: how long a quiet project stays. */
  idleHideMs: number;
  /** Pinned projects always stay. */
  pinned: ReadonlySet<string>;
  /** When the user last opened each project from the board: that counts as activity. */
  opened: ReadonlyMap<string, number>;
}

type Board = Pick<BoardState, 'projects' | 'windows' | 'terminals' | 'sessions'>;

/**
 * Closed projects (12.6e) with nothing newer than their close: off the overview, the rail and
 * the phone list. A new editor window, terminal or Claude session there, or the user opening it
 * from the board, brings one back (the server clears `closedAt` soon after; this covers the gap).
 */
export function closedProjectIds(
  board: Board,
  opened: ReadonlyMap<string, number> = new Map(),
): Set<string> {
  const closed = new Map<string, number>();
  for (const project of Object.values(board.projects)) {
    if (project.closedAt != null) closed.set(project.id, project.closedAt);
  }
  if (closed.size === 0) return new Set();
  const reopen = (id: string | null, at: number) => {
    const closedAt = id === null ? undefined : closed.get(id);
    if (id !== null && closedAt !== undefined && at > closedAt) closed.delete(id);
  };
  for (const window of Object.values(board.windows)) {
    for (const id of window.projectIds) reopen(id, window.connectedAt);
  }
  for (const terminal of Object.values(board.terminals)) {
    if (terminal.state === 'open') reopen(terminal.projectId, terminal.createdAt);
  }
  for (const session of Object.values(board.sessions)) {
    if (session.status.kind !== 'ended') reopen(session.projectId, session.startedAt);
  }
  for (const [id, at] of opened) reopen(id, at);
  return new Set(closed.keys());
}

/**
 * The projects the overview shows, in no particular order: pinned ones, and any with a connected
 * editor window, an open terminal, a live Claude session, or activity (or a board open) within
 * the idle window.
 */
export function activeProjectIds(board: Board, rule: ActiveRule): Set<string> {
  const active = new Set<string>();
  const closed = closedProjectIds(board, rule.opened);
  for (const window of Object.values(board.windows)) {
    for (const id of window.projectIds) active.add(id);
  }
  for (const terminal of Object.values(board.terminals)) {
    if (terminal.projectId !== null && terminal.state === 'open') active.add(terminal.projectId);
  }
  for (const session of Object.values(board.sessions)) {
    if (session.projectId === null) continue;
    // An interrupted board session waits for Resume; it isn't running anything.
    if (session.status.kind === 'ended' || session.status.kind === 'interrupted') continue;
    active.add(session.projectId);
  }
  const since = rule.now - rule.idleHideMs;
  for (const project of Object.values(board.projects)) {
    if (active.has(project.id)) continue;
    const last = Math.max(project.lastActivityAt ?? 0, rule.opened.get(project.id) ?? 0);
    if (rule.pinned.has(project.id) || last >= since) active.add(project.id);
  }
  // Windows and terminals can name a project the board has dropped.
  for (const id of active) if (!board.projects[id] || closed.has(id)) active.delete(id);
  return active;
}

/** `activeProjectIds` as a sorted, joined key: a string selector re-renders only when it changes. */
export function activeKey(board: Board, rule: ActiveRule): string {
  return [...activeProjectIds(board, rule)].sort().join('\n');
}

/** `closedProjectIds` as a sorted, joined key, for a string selector. */
export function closedKey(board: Board, opened: ReadonlyMap<string, number>): string {
  return [...closedProjectIds(board, opened)].sort().join('\n');
}

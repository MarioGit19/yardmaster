import type { BoardState } from '@c-board/protocol';

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
 * The projects the overview shows, in no particular order: pinned ones, and any with a connected
 * editor window, an open terminal, a live Claude session, or activity (or a board open) within
 * the idle window.
 */
export function activeProjectIds(board: Board, rule: ActiveRule): Set<string> {
  const active = new Set<string>();
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
  for (const id of active) if (!board.projects[id]) active.delete(id);
  return active;
}

/** `activeProjectIds` as a sorted, joined key: a string selector re-renders only when it changes. */
export function activeKey(board: Board, rule: ActiveRule): string {
  return [...activeProjectIds(board, rule)].sort().join('\n');
}

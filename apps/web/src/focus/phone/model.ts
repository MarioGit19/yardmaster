import type { BoardState, ClaudeSession, SessionStatus } from '@yardmaster/protocol';
import { terminalSession } from '../../data/selectors.js';
import { laneExecution, laneView } from '../../lanes/lane.js';
import { podSessions } from '../../pod/model.js';
import { sessionHref, terminalHref } from '../../routes.js';
import { stackOrder } from '../../terminal/stack.js';

/** The phone hub's groups (DESIGN.md §11), in list order. */
export const HUB_GROUPS = ['needs', 'running', 'idle'] as const;
export type HubGroup = (typeof HUB_GROUPS)[number];

export const HUB_GROUP_LABEL: Record<HubGroup, string> = {
  needs: 'Needs you',
  running: 'Running',
  idle: 'Idle',
};

/**
 * One card on the hub: a Claude session (with the terminal it runs in, if any: one card, never
 * two) or a plain terminal.
 */
export type HubItem =
  | { kind: 'session'; key: string; group: HubGroup; sessionId: string; terminalId: string | null }
  | { kind: 'terminal'; key: string; group: HubGroup; terminalId: string };

/** The workspace's sub-pages beside the items. `new` is a blank new-session chat. */
export const HUB_PAGES = ['git', 'history', 'ports', 'new'] as const;
export type HubPage = (typeof HUB_PAGES)[number];

export const isHubPage = (page: string): page is HubPage =>
  (HUB_PAGES as readonly string[]).includes(page);

const NEEDS = new Set<SessionStatus['kind']>(['waiting_permission', 'waiting_input']);
const BUSY = new Set<SessionStatus['kind']>(['working', 'tool', 'compacting']);

export function sessionGroup(status: SessionStatus): HubGroup {
  if (NEEDS.has(status.kind)) return 'needs';
  if (BUSY.has(status.kind) || (status.kind === 'unknown' && status.alive)) return 'running';
  return 'idle';
}

/**
 * Every Claude session and terminal of the project as hub cards, grouped Needs you, Running,
 * Idle. Live sessions come first in each group (most urgent, then newest), then ended ones, then
 * terminals in the stack's order. A terminal running a live Claude session folds into its card.
 */
export function hubItems(
  board: Pick<BoardState, 'sessions' | 'terminals' | 'executions'>,
  projectId: string,
): HubItem[] {
  const sessions = Object.values(board.sessions).filter((s) => s.projectId === projectId);
  const terminals = stackOrder(
    Object.values(board.terminals).filter((t) => t.projectId === projectId),
  );
  const terminalOf = new Map<string, string>();
  for (const terminal of terminals) {
    const session = terminalSession(board, terminal.id);
    if (session) terminalOf.set(session.id, terminal.id);
  }
  const ordered: ClaudeSession[] = [
    ...podSessions(sessions),
    ...sessions
      .filter((s) => s.status.kind === 'ended')
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id)),
  ];
  const items: HubItem[] = ordered.map((session) => ({
    kind: 'session',
    key: `s:${session.id}`,
    group: sessionGroup(session.status),
    sessionId: session.id,
    terminalId: terminalOf.get(session.id) ?? null,
  }));
  const folded = new Set(terminalOf.values());
  for (const terminal of terminals) {
    if (folded.has(terminal.id)) continue;
    const execution = laneExecution(board, terminal);
    const running =
      terminal.state === 'open' && execution.id !== null && execution.endedAt === null;
    items.push({
      kind: 'terminal',
      key: `t:${terminal.id}`,
      group: running ? 'running' : 'idle',
      terminalId: terminal.id,
    });
  }
  return HUB_GROUPS.flatMap((group) => items.filter((item) => item.group === group));
}

/** How many items failed: a session in error, or a terminal whose last command exited non-zero. */
export function hubFailures(
  board: Pick<BoardState, 'sessions' | 'terminals' | 'executions'>,
  items: readonly HubItem[],
): number {
  let failed = 0;
  for (const item of items) {
    if (item.kind === 'session') {
      if (board.sessions[item.sessionId]?.status.kind === 'error') failed++;
      continue;
    }
    const terminal = board.terminals[item.terminalId];
    if (terminal && laneView(terminal, laneExecution(board, terminal), '').tone === 'err') failed++;
  }
  return failed;
}

/** `hubItems` as one string, so a store selector compares it by value. */
export const hubItemsKey = (items: readonly HubItem[]) =>
  items
    .map((i) => `${i.key} ${i.group} ${i.kind === 'session' ? (i.terminalId ?? '') : ''}`)
    .join('\n');

/** Reads `hubItemsKey` back. */
export function parseHubItems(key: string): HubItem[] {
  if (key === '') return [];
  return key.split('\n').map((line) => {
    const [itemKey = '', group = 'idle', terminalId = ''] = line.split(' ');
    const id = itemKey.slice(2);
    return itemKey.startsWith('s:')
      ? {
          kind: 'session',
          key: itemKey,
          group: group as HubGroup,
          sessionId: id,
          terminalId: terminalId || null,
        }
      : { kind: 'terminal', key: itemKey, group: group as HubGroup, terminalId: id };
  });
}

/** The item a workspace route points at: a session, or a terminal (a Claude one is its session). */
export function routeItem(
  items: readonly HubItem[],
  route: { sessionId?: string; terminalId?: string },
): HubItem | null {
  if (route.sessionId) {
    return items.find((i) => i.kind === 'session' && i.sessionId === route.sessionId) ?? null;
  }
  if (route.terminalId) {
    return items.find((i) => i.terminalId === route.terminalId) ?? null;
  }
  return null;
}

export function itemHref(projectId: string, item: HubItem): string {
  return item.kind === 'session'
    ? sessionHref(projectId, item.sessionId)
    : terminalHref(projectId, item.terminalId);
}

/** The card a swipe moves to: the next (1) or previous (-1) one in hub order, or null at the ends. */
export function neighbour(items: readonly HubItem[], key: string, step: 1 | -1): HubItem | null {
  const index = items.findIndex((i) => i.key === key);
  if (index === -1) return null;
  return items[index + step] ?? null;
}

/** The first other card that needs the user: what the amber bar on an item page opens. */
export function otherNeedsYou(items: readonly HubItem[], key: string | null): HubItem | null {
  return items.find((i) => i.group === 'needs' && i.key !== key) ?? null;
}

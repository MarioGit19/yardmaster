import { type SeenResponse, sessionDisplayName } from '@yardmaster/protocol';
import { isCrashExit } from '../data/selectors.js';
import type { BoardStoreState } from '../data/store.js';
import { selectLaneExecution, terminalDisplay } from '../lanes/lane.js';
import { sessionCaption, sessionWhen } from '../pod/model.js';
import { sessionHref, terminalHref } from '../routes.js';
import { type HudItem, selectHudItems } from '../shell/counts.js';

/** Rows the strip shows before the rest fold behind "+N more". */
export const STRIP_ROWS = 3;

export interface StripItem {
  /** `s:<session>` or `t:<terminal>`. */
  key: string;
  token: 'needs_you' | 'failed';
  project: string;
  /** The session or terminal, for a project with more than one. */
  name: string;
  reason: string;
  /** When it started waiting or failed. */
  since: number;
  /** Null when no project has claimed it yet: there's no page to open. */
  href: string | null;
  /** A pending approval the strip can decide. */
  approvalId: string | null;
  /** The command the strip can run again. */
  rerun: { execId: string; command: string } | null;
}

function sessionItem(
  s: BoardStoreState,
  session: Extract<HudItem, { kind: 'session' }>['session'],
  token: StripItem['token'],
  now: number,
): StripItem {
  const { status, projectId, id } = session;
  const held = status.kind === 'waiting_permission' ? status.approvalId : null;
  const approval = held ? s.board.approvals[held] : null;
  const pending = approval?.state === 'pending' ? approval : null;
  return {
    key: `s:${id}`,
    token,
    project: s.board.projects[projectId ?? '']?.name ?? 'No project',
    name: sessionDisplayName(session),
    reason: sessionCaption(session, pending).text,
    since: sessionWhen(session, pending, now)?.at ?? session.updatedAt,
    href: projectId ? sessionHref(projectId, id) : null,
    approvalId: pending?.id ?? null,
    rerun: null,
  };
}

function terminalItem(
  s: BoardStoreState,
  { terminal, lane }: Extract<HudItem, { kind: 'terminal' }>,
): StripItem {
  const { id, projectId } = terminal;
  const execution = selectLaneExecution(terminal)(s);
  const code = lane.exit?.code;
  const rerun =
    terminal.state === 'open' && lane.safe && lane.command !== null && execution.id !== null;
  return {
    key: `t:${id}`,
    token: 'failed',
    project: s.board.projects[projectId ?? '']?.name ?? 'No project',
    name: terminalDisplay(terminal, execution).name,
    reason: `${lane.command ?? 'Terminal'} exited ${code}`,
    since: execution.endedAt ?? terminal.createdAt,
    href: projectId ? terminalHref(projectId, id) : null,
    approvalId: null,
    rerun:
      rerun && execution.id && lane.command
        ? { execId: execution.id, command: lane.command }
        : null,
  };
}

/**
 * Everything with a high token, oldest first. Failures follow the top bar's Failed counter: one
 * this browser has opened has been dealt with. A Ctrl+C isn't a failure that needs anyone.
 */
export const selectStripItems =
  (seen: SeenResponse, now: number) =>
  (s: BoardStoreState): StripItem[] => {
    const clock = () => now;
    const items: StripItem[] = [];
    for (const item of selectHudItems('needsYou', seen, clock)(s)) {
      if (item.kind === 'session') items.push(sessionItem(s, item.session, 'needs_you', now));
    }
    for (const item of selectHudItems('failed', seen, clock)(s)) {
      if (item.kind === 'session') items.push(sessionItem(s, item.session, 'failed', now));
      else if (isCrashExit(item.lane.exit?.code)) items.push(terminalItem(s, item));
    }
    return items.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
  };

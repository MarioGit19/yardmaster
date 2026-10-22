import type { Approval, ApprovalState, ClaudeSession, Project } from '@c-board/protocol';
import type { BoardStoreState } from '../data/store.js';
import type { MotionLevel } from '../motion.js';
import { createPreference, type KeyValueStorage } from '../prefs.js';

// Whether the sheet is open lives only in memory: a reload starts with it closed.
const memory: KeyValueStorage = { getItem: () => null, setItem: () => {} };

export const attentionOpen = createPreference<'open' | 'closed'>(
  'cboard.attention',
  ['open', 'closed'],
  'closed',
  memory,
);

/** Browser notifications for new approvals: opt-in, turned on in Settings. */
export const notificationsPreference = createPreference<'on' | 'off'>(
  'cboard.notifications',
  ['on', 'off'],
  'off',
);

export const isWaiting = (session: Pick<ClaudeSession, 'status'>) =>
  session.status.kind === 'waiting_permission' || session.status.kind === 'waiting_input';

/** Sessions waiting for the user, longest-waiting first. */
export const selectWaitingSessions = (s: BoardStoreState): ClaudeSession[] =>
  Object.values(s.board.sessions)
    .filter(isWaiting)
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));

/**
 * Waiting sessions the board can't answer with a card: a reply is due, or a terminal session
 * asks in its terminal (no approval reached us).
 */
export const selectWaitingWithoutApproval = (s: BoardStoreState): ClaudeSession[] =>
  selectWaitingSessions(s).filter((session) => {
    if (session.status.kind !== 'waiting_permission') return true;
    const id = session.status.approvalId;
    return !id || s.board.approvals[id]?.state !== 'pending';
  });

export type AttentionDecision = 'allow' | 'allowAlways' | 'deny';

export type AttentionKey =
  | { kind: 'decide'; decision: AttentionDecision }
  | { kind: 'move'; by: 1 | -1 };

/**
 * The sheet's keyboard: A allows, ⇧A always allows, D starts a denial, and ↑↓ (or K/J) move
 * between cards. Null for everything else, including chords with ⌘, Ctrl or Alt.
 */
export function attentionKey(event: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): AttentionKey | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case 'a':
    case 'A':
      return { kind: 'decide', decision: event.shiftKey ? 'allowAlways' : 'allow' };
    case 'd':
    case 'D':
      return event.shiftKey ? null : { kind: 'decide', decision: 'deny' };
    case 'ArrowDown':
    case 'j':
      return { kind: 'move', by: 1 };
    case 'ArrowUp':
    case 'k':
      return { kind: 'move', by: -1 };
    default:
      return null;
  }
}

/** Whether "Always allow" would save a rule; without suggestions it only allows once. */
export const canAlwaysAllow = (approval: Pick<Approval, 'suggestions'>) =>
  (approval.suggestions?.length ?? 0) > 0;

/** "acme-shop wants to run Bash": the toast title and the screen-reader announcement. */
export function approvalHeadline(
  approval: Pick<Approval, 'tool'>,
  project: Pick<Project, 'name'> | undefined,
): string {
  return `${project?.name ?? 'Claude'} wants to run ${approval.tool}`;
}

export const RESOLVED_LABEL: Record<ApprovalState, string> = {
  pending: 'Waiting',
  allowed: 'Allowed',
  denied: 'Denied',
  expired: 'Expired',
};

/** An expired card's countdown ring runs out over this long before the card fades. */
export const EXPIRE_FINISH_MS = 450;
/** An allowed card shows its outcome and drawn check this long, then collapses. */
export const COLLAPSE_AT_MS = 520;

/**
 * How long a decided card stays in the list showing its outcome. Allow draws its check and
 * collapses the card (Reduced only shows the check); Deny fades out after a short beat; Expire lets
 * the countdown ring finish. Off removes it at once.
 */
export function lingerFor(state: ApprovalState, level: MotionLevel): number {
  if (level === 'off') return 0;
  switch (state) {
    case 'allowed':
      return level === 'full' ? 1000 : 700;
    case 'denied':
      return 450;
    case 'expired':
      return EXPIRE_FINISH_MS + 200;
    case 'pending':
      return 0;
  }
}

/** A payload path inside the project, shown relative to it. */
export function relativeToProject(path: string, projectPath: string | undefined): string {
  return projectPath && path.startsWith(`${projectPath}/`)
    ? path.slice(projectPath.length + 1)
    : path;
}

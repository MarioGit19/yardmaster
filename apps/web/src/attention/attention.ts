import {
  type Approval,
  type ApprovalState,
  type ClaudeSession,
  HOOK_PERMISSION_MODES,
  type HookPermissionMode,
  type PermissionMode,
  type Project,
  type UiAction,
} from '@yardmaster/protocol';
import { toast } from 'sonner';
import type { BoardClient } from '../data/client.js';
import type { BoardStoreState } from '../data/store.js';
import type { MotionLevel } from '../motion.js';
import { createPreference, type KeyValueStorage } from '../prefs.js';
import { routes } from '../routes.js';
import { ESC } from '../terminal/claudeTerminal.js';
import { actionErrorText } from '../terminal/stack.js';

// Whether the sheet is open lives only in memory: a reload starts with it closed.
const memory: KeyValueStorage = { getItem: () => null, setItem: () => {} };

export const attentionOpen = createPreference<'open' | 'closed'>(
  'yardmaster.attention',
  ['open', 'closed'],
  'closed',
  memory,
);

/** Browser notifications for new approvals: opt-in, turned on in Settings. */
export const notificationsPreference = createPreference<'on' | 'off'>(
  'yardmaster.notifications',
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

/** One row of the inbox: a request the board can decide, or a session to answer in place. */
export type InboxItem =
  | { kind: 'approval'; key: string; since: number; approval: Approval }
  | { kind: 'session'; key: string; since: number; session: ClaudeSession };

/** Everything waiting across projects, oldest first. */
export function inboxItems(
  pending: readonly Approval[],
  waiting: readonly ClaudeSession[],
): InboxItem[] {
  return [
    ...pending.map(
      (approval): InboxItem => ({
        kind: 'approval',
        key: approval.id,
        since: approval.createdAt,
        approval,
      }),
    ),
    ...waiting.map(
      (session): InboxItem => ({
        kind: 'session',
        key: `s:${session.id}`,
        since: session.updatedAt,
        session,
      }),
    ),
  ].sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
}

const targetListeners = new Set<() => void>();
let target: string | null = null;

/**
 * The item the inbox should select when it can: it may not be on the board yet when a notification
 * opens the app. Lives in memory, like the sheet.
 */
export const inboxTarget = {
  get: () => target,
  set(next: string | null) {
    target = next;
    for (const listener of targetListeners) listener();
  },
  subscribe(listener: () => void) {
    targetListeners.add(listener);
    return () => {
      targetListeners.delete(listener);
    };
  },
};

/** Opens the inbox on one item (the Attention tab on a phone). */
export function openInboxItem(key: string): void {
  inboxTarget.set(key);
  attentionOpen.set('open');
}

/** Whether a phone's installed app should open on the Attention tab rather than the overview. */
export const landsOnAttention = (env: {
  standalone: boolean;
  location: string;
  waiting: number;
}): boolean => env.standalone && env.location === routes.overview && env.waiting > 0;

/**
 * How to stop a session from outside. Board sessions stop through the SDK; a terminal's Claude
 * Code stops on Esc, like its own key.
 */
export function sessionInterruptAction(
  session: Pick<ClaudeSession, 'id' | 'origin' | 'terminalId'>,
): UiAction | null {
  if (session.origin === 'board') return { kind: 'session.interrupt', sessionId: session.id };
  return session.terminalId
    ? { kind: 'terminal.sendText', terminalId: session.terminalId, text: ESC, execute: false }
    : null;
}

/**
 * What Interrupt does on an inbox item. A request held by the hook is answered with a stop: Esc
 * would reach a terminal that shows no prompt. Without one, only a session mid-turn has anything
 * to stop; one waiting for a reply has already ended its turn.
 */
export function inboxInterrupt(
  session: ClaudeSession,
  approval: Pick<Approval, 'source'> | null,
): { kind: 'stopRequest' } | { kind: 'action'; action: UiAction } | null {
  if (approval?.source === 'hook') return { kind: 'stopRequest' };
  if (session.status.kind !== 'waiting_permission') return null;
  const action = sessionInterruptAction(session);
  return action ? { kind: 'action', action } : null;
}

/**
 * How an item can change the session's permission mode. A board session switches through the SDK
 * and its request stays open. A terminal session has no way in except the hook's answer, so there
 * the switch comes with allowing the request, and a terminal prompt with no hook behind it has none.
 */
export function inboxModeSwitch(
  session: Pick<ClaudeSession, 'origin' | 'permissionMode'>,
  approval: Pick<Approval, 'source'> | null,
): { kind: 'session' } | { kind: 'allowWith'; modes: readonly HookPermissionMode[] } | null {
  if (approval?.source === 'hook') {
    const current: PermissionMode = session.permissionMode ?? 'default';
    return { kind: 'allowWith', modes: HOOK_PERMISSION_MODES.filter((m) => m !== current) };
  }
  return session.origin === 'board' ? { kind: 'session' } : null;
}

export type AttentionDecision = 'allow' | 'allowAlways' | 'deny';

export type AttentionKey =
  | { kind: 'decide'; decision: AttentionDecision }
  | { kind: 'move'; by: 1 | -1 }
  | { kind: 'open' };

/**
 * The sheet's keyboard: A allows, ⇧A always allows, D starts a denial, ↑↓ (or K/J) move between
 * items and Enter opens the session. Null for everything else, including chords with ⌘, Ctrl or
 * Alt.
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
    case 'Enter':
      return { kind: 'open' };
    default:
      return null;
  }
}

/** Sends a decision; says so if it fails. */
export async function decideApproval(
  client: Pick<BoardClient, 'request'>,
  approvalId: string,
  decision: AttentionDecision,
  reason?: string,
  extra: { interrupt?: boolean; mode?: HookPermissionMode } = {},
): Promise<boolean> {
  const { interrupt, mode } = extra;
  const result = await client.request(
    'approval.decide',
    decision === 'deny'
      ? { approvalId, decision, ...(reason ? { reason } : {}), ...(interrupt ? { interrupt } : {}) }
      : decision === 'allow' && mode
        ? { approvalId, decision, mode }
        : { approvalId, decision },
  );
  if (!result.ok) toast.error(actionErrorText(result.error, 'The decision did not go through'));
  return result.ok;
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

import { randomUUID } from 'node:crypto';
import {
  type ActivityEvent,
  type Approval,
  type ApprovalDecision,
  type AwayStatusResponse,
  LOCAL_ROUTES,
  makeMessage,
  type PermissionHookAnswer,
  PermissionRequestHook,
  PermissionSuggestion,
  type ServerToUi,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ActionResult } from '../actions.js';
import type { BoardStore } from '../store.js';
import {
  claudePidHeader,
  HOOK_BODY_LIMIT,
  type HookIngest,
  parseClaudePid,
} from './hook-ingest.js';
import { RESOLVED_APPROVAL_TTL_MS, UNKNOWN_APPROVAL } from './runner.js';

export const AWAY_ROUTE = LOCAL_ROUTES.away;
export const PERMISSION_ROUTE = LOCAL_ROUTES.permission;

const REASON_MAX = 500;

export interface AwayApprovalsOptions {
  store: BoardStore;
  /** Applies the request like any other hook event first (session status, activity). */
  ingest: HookIngest;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  /** The current away-mode setting. */
  status: () => AwayStatusResponse;
  /** Off in demo mode: the hook always gets "no decision". */
  apply?: boolean;
  onMessage?: (message: ServerToUi) => void;
  onActivity?: (event: ActivityEvent) => void;
  newId?: () => string;
  now?: () => number;
}

interface Pending {
  approval: Approval;
  suggestions: PermissionSuggestion[];
  timer: NodeJS.Timeout;
  resolve: (answer: PermissionHookAnswer | null) => void;
  dispose: () => void;
}

/**
 * Away mode (F13): `PermissionRequest` hooks from terminal sessions wait here as pending
 * approvals until the board decides, the wait times out, or the hook goes away (the user
 * answered in the terminal, or Claude Code gave up on it).
 */
export class AwayApprovals {
  private readonly pending = new Map<string, Pending>();
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: AwayApprovalsOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.pending.size;
  }

  status(): AwayStatusResponse {
    return this.options.status();
  }

  /**
   * Waits for the board's decision; null means "no decision", and the terminal prompt shows.
   * The hook turns the answer into Claude Code's output itself.
   */
  async request(
    raw: unknown,
    claudePid: number | null,
    signal: AbortSignal,
  ): Promise<PermissionHookAnswer | null> {
    const hook = PermissionRequestHook.safeParse(raw);
    if (!hook.success) {
      this.options.logger.warn(
        { issues: hook.error.issues.length },
        'skipping malformed permission request',
      );
      return null;
    }
    const { away, timeoutSec } = this.options.status();
    if (!away || this.options.apply === false || signal.aborted) return null;

    await this.options.ingest.enqueue(raw, claudePid);
    if (signal.aborted) return null;

    const ts = this.now();
    const suggestions = (hook.data.permission_suggestions ?? []).flatMap((entry) => {
      const parsed = PermissionSuggestion.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    const approval: Approval = {
      id: this.newId(),
      sessionId: hook.data.session_id,
      source: 'hook',
      tool: hook.data.tool_name,
      input: hook.data.tool_input ?? {},
      toolUseId: null,
      suggestions,
      blockedPath: null,
      createdAt: ts,
      expiresAt: ts + timeoutSec * 1000,
      state: 'pending',
      decidedAt: null,
      reason: null,
    };

    return new Promise<PermissionHookAnswer | null>((resolve) => {
      const onAbort = () => this.settle(approval.id, 'expired', 'Answered in the terminal', null);
      const pending: Pending = {
        approval,
        suggestions,
        timer: setTimeout(
          () => this.settle(approval.id, 'expired', 'Timed out', null),
          timeoutSec * 1000,
        ),
        resolve,
        dispose: () => signal.removeEventListener('abort', onAbort),
      };
      this.pending.set(approval.id, pending);
      signal.addEventListener('abort', onAbort, { once: true });

      const { store } = this.options;
      store.upsertApproval(approval);
      const status = store.state.sessions[approval.sessionId]?.status;
      if (status && status.kind !== 'ended') {
        store.setSessionStatus(
          approval.sessionId,
          { kind: 'waiting_permission', approvalId: approval.id },
          ts,
        );
      }
      this.options.onMessage?.(makeMessage('approval.new', { approval }, { ts }));
    });
  }

  /** Handles a UI `approval.decide` for an away-mode approval. */
  decide(decision: ApprovalDecision): ActionResult {
    const pending = this.pending.get(decision.approvalId);
    if (!pending) return { ok: false, error: UNKNOWN_APPROVAL };
    if (decision.decision === 'deny') {
      const reason = clip(decision.reason);
      this.settle(decision.approvalId, 'denied', reason, {
        decision: decision.interrupt ? 'deny_and_stop' : 'deny',
        reason,
      });
    } else if (decision.decision === 'allowAlways' && pending.suggestions.length > 0) {
      this.settle(decision.approvalId, 'allowed', null, { decision: 'allow_always' });
    } else {
      const mode = decision.decision === 'allow' ? decision.mode : undefined;
      this.settle(decision.approvalId, 'allowed', null, {
        decision: 'allow',
        ...(mode ? { mode } : {}),
      });
    }
    return { ok: true };
  }

  /** Expires every pending approval: the hooks fall back to the terminal prompt. */
  closeAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'expired', 'Board stopped', null);
  }

  private settle(
    id: string,
    state: 'allowed' | 'denied' | 'expired',
    reason: string | null,
    answer: PermissionHookAnswer | null,
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.dispose();
    const { approval } = pending;
    const { store } = this.options;
    const ts = this.now();
    store.resolveApproval(id, state, reason, ts);
    this.options.onMessage?.(makeMessage('approval.resolved', { approvalId: id, state, reason }));
    setTimeout(() => store.removeApproval(id), RESOLVED_APPROVAL_TTL_MS).unref();

    const status = store.state.sessions[approval.sessionId]?.status;
    if (status?.kind === 'waiting_permission' && status.approvalId === id) {
      store.setSessionStatus(
        approval.sessionId,
        state === 'allowed'
          ? { kind: 'tool', tool: approval.tool, toolUseId: null }
          : answer?.decision === 'deny_and_stop'
            ? { kind: 'idle' }
            : state === 'denied'
              ? { kind: 'working' }
              : // Still waiting, now on the terminal's own prompt.
                { kind: 'waiting_permission', approvalId: null },
        ts,
      );
    }
    this.options.onActivity?.({
      id: this.newId(),
      ts,
      kind: 'permission.decision',
      projectId: store.state.sessions[approval.sessionId]?.projectId ?? null,
      sessionId: approval.sessionId,
      terminalId: null,
      execId: null,
      summary: `${approval.tool} ${state}`,
      data: { approval_id: id, decision: state },
    });
    pending.resolve(answer);
  }
}

function clip(text: string | undefined): string | null {
  const line = text?.trim();
  if (!line) return null;
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

/**
 * `GET /api/away` and the long-polling `POST /api/hooks/permission`, both on the local socket
 * with the token. The POST answers 200 with a `PermissionHookAnswer` on a decision, else 204.
 */
export function registerAwayRoutes(app: FastifyInstance, away: AwayApprovals): void {
  app.get(AWAY_ROUTE, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return away.status();
  });

  app.post(PERMISSION_ROUTE, { bodyLimit: HOOK_BODY_LIMIT }, async (request, reply) => {
    const controller = new AbortController();
    // The hook process exiting closes the connection before we answer.
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const pid = parseClaudePid(claudePidHeader(request.headers));
    const answer = await away.request(request.body, pid, controller.signal);
    reply.header('cache-control', 'no-store');
    if (answer === null) return reply.code(204).send();
    return reply.code(200).send(answer);
  });

  // Answer the waiting hooks before the server waits for their connections to close.
  app.addHook('preClose', async () => away.closeAll());
}

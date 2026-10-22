import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import {
  type ActivityEvent,
  type ActivityKind,
  type Approval,
  type ApprovalDecision,
  type ClaudeSession,
  makeMessage,
  type PermissionMode,
  PermissionMode as PermissionModeSchema,
  PermissionSuggestion,
  type ServerToUi,
  type SessionStatus,
  toolFamily,
} from '@c-board/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { ActionHandlers, ActionResult } from '../actions.js';
import type { BoardStore } from '../store.js';
import { toolSummary } from './session-reducer.js';

// Headless Claude sessions run from the board through the Agent SDK (PRD F6, §6.2).

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/** Where SDK messages go to become the session's `transcript:` stream. */
export interface TranscriptFeed {
  claim(sessionId: string): void;
  feed(sessionId: string, entries: readonly unknown[]): void;
  release(sessionId: string): void;
}

export interface SessionRunnerOptions {
  store: BoardStore;
  transcripts: TranscriptFeed | null;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  /** Defaults to the Agent SDK's `query`. */
  query?: QueryFn;
  newId?: () => string;
  now?: () => number;
  /** How often streaming text reaches the store. */
  draftIntervalMs?: number;
  /** Approval notices for UI clients (`approval.new`, `approval.resolved`). */
  onMessage?: (message: ServerToUi) => void;
  onActivity?: (event: ActivityEvent) => void;
  /** Pending approvals expire (deny) after this long. `null`, the default: they wait. */
  approvalTimeoutMs?: number | null;
}

export interface StartSessionInput {
  projectId: string;
  prompt: string;
  model?: string;
  permissionMode?: PermissionMode;
}

export interface ResumeSessionInput {
  /** Locates a session the store doesn't hold (from the history browser). */
  projectId?: string;
  /** Continue under a new id instead (`forkSession`). */
  fork?: boolean;
}

export type RunnerResult = { ok: true; sessionId: string } | { ok: false; error: string };

export const UNKNOWN_PROJECT = 'unknown_project';
export const UNKNOWN_SESSION = 'unknown_session';
export const SESSION_LIVE = 'session_live';
export const NOT_RUNNING = 'session_not_running';
export const UNKNOWN_APPROVAL = 'unknown_approval';

export const DRAFT_INTERVAL_MS = 50;
const DRAFT_MAX = 100_000;
const TITLE_MAX = 120;
const TEXT_MAX = 4_000;
const REASON_MAX = 1_000;
/** Resolved approvals stay in the store this long, so the UI can show the outcome. */
export const RESOLVED_APPROVAL_TTL_MS = 60_000;
const DENY_MESSAGE = 'The user denied this action from c-board.';

/** An async queue the SDK reads user messages from (streaming-input mode). */
export class MessageQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

interface Run {
  id: string;
  query: Query;
  input: MessageQueue<SDKUserMessage>;
  closing: boolean;
  /** An interrupt is pending; the turn's error result is expected. */
  interrupted: boolean;
  draft: string | null;
  draftTimer: NodeJS.Timeout | null;
  done: Promise<void>;
}

interface PendingApproval {
  approval: Approval;
  runId: string;
  /** Returned as `updatedPermissions` on "Always allow". */
  suggestions: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
  timer: NodeJS.Timeout | null;
  dispose: () => void;
}

// Only the fields the runner reads; SDK messages are parsed defensively like transcript lines.
const Base = z.looseObject({ type: z.string(), parent_tool_use_id: z.string().nullish() });
const SystemInit = z.looseObject({
  subtype: z.literal('init'),
  model: z.string().max(128).optional(),
  permissionMode: PermissionModeSchema.optional().catch(undefined),
});
const StateChanged = z.looseObject({
  subtype: z.literal('session_state_changed'),
  state: z.enum(['idle', 'running', 'requires_action']),
});
const StatusMessage = z.looseObject({
  subtype: z.literal('status'),
  status: z.string().nullable(),
  permissionMode: PermissionModeSchema.optional().catch(undefined),
});
const Block = z.looseObject({ type: z.string() });
const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  input: z.unknown(),
});
const AssistantMessage = z.looseObject({
  message: z.looseObject({ content: z.array(z.unknown()) }),
});
const UserMessage = z.looseObject({
  message: z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) }),
});
const Result = z.looseObject({
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
});
const StreamEvent = z.looseObject({
  event: z.looseObject({
    type: z.string(),
    content_block: Block.optional(),
    delta: z.looseObject({ type: z.string(), text: z.string().optional() }).optional(),
  }),
});

/**
 * Runs board sessions in-process with the Agent SDK's `query()` in streaming-input mode,
 * one query per live session. SDK messages drive the session in the store (status, model,
 * current tool, streaming draft) and feed its transcript stream.
 */
export class SessionRunner {
  private readonly store: BoardStore;
  private readonly transcripts: TranscriptFeed | null;
  private readonly log: SessionRunnerOptions['logger'];
  private readonly loadQuery: () => Promise<QueryFn>;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly draftIntervalMs: number;
  private readonly runs = new Map<string, Run>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly onMessage: (message: ServerToUi) => void;
  private readonly onActivity: ((event: ActivityEvent) => void) | undefined;
  private readonly approvalTimeoutMs: number | null;

  constructor(options: SessionRunnerOptions) {
    this.store = options.store;
    this.transcripts = options.transcripts;
    this.log = options.logger;
    const injected = options.query;
    let loading: Promise<QueryFn> | null = null;
    this.loadQuery = injected
      ? () => Promise.resolve(injected)
      : () => {
          loading ??= loadSdkQuery();
          return loading;
        };
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.draftIntervalMs = options.draftIntervalMs ?? DRAFT_INTERVAL_MS;
    this.onMessage = options.onMessage ?? (() => {});
    this.onActivity = options.onActivity;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? null;
  }

  isLive(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  async startSession(input: StartSessionInput): Promise<RunnerResult> {
    // Loaded before any check, so everything after it runs in one synchronous step.
    const queryFn = await this.loadQuery();
    const project = this.store.state.projects[input.projectId];
    if (!project) return { ok: false, error: UNKNOWN_PROJECT };
    const id = this.newId();
    const ts = this.now();
    this.transcripts?.claim(id);
    this.store.upsertSession({
      id,
      origin: 'board',
      projectId: project.id,
      cwd: project.path,
      status: { kind: 'working' },
      title: clipLine(input.prompt, TITLE_MAX),
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? null,
      startedAt: ts,
      updatedAt: ts,
    });
    this.launch(queryFn, id, {
      cwd: project.path,
      sessionId: id,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    });
    this.pushPrompt(id, input.prompt);
    return { ok: true, sessionId: id };
  }

  /** Resumes a past session; it waits for `send`. Already live: nothing to do. */
  async resumeSession(sessionId: string, input: ResumeSessionInput = {}): Promise<RunnerResult> {
    const queryFn = await this.loadQuery();
    if (this.runs.has(sessionId) && !input.fork) return { ok: true, sessionId };
    const session = this.store.state.sessions[sessionId];
    const projectId = session?.projectId ?? input.projectId ?? null;
    const project = projectId === null ? undefined : this.store.state.projects[projectId];
    const cwd = session?.cwd ?? project?.path ?? null;
    if (cwd === null) return { ok: false, error: session ? UNKNOWN_PROJECT : UNKNOWN_SESSION };
    // Two processes writing one transcript would corrupt it: a live terminal session forks.
    if (!input.fork && session && session.origin === 'terminal' && isLiveStatus(session.status)) {
      return { ok: false, error: SESSION_LIVE };
    }

    const id = input.fork ? this.newId() : sessionId;
    const ts = this.now();
    this.transcripts?.claim(id);
    this.store.upsertSession({
      id,
      origin: 'board',
      projectId: project?.id ?? session?.projectId ?? null,
      cwd,
      status: { kind: 'idle' },
      title: session?.title ?? null,
      model: session?.model ?? null,
      permissionMode: session?.permissionMode ?? null,
      ...(input.fork || !session ? { startedAt: ts } : {}),
      endedAt: null,
      updatedAt: ts,
    });
    this.launch(queryFn, id, {
      cwd,
      resume: sessionId,
      ...(input.fork ? { forkSession: true, sessionId: id } : {}),
      ...(session?.model ? { model: session.model } : {}),
      ...(session?.permissionMode ? { permissionMode: session.permissionMode } : {}),
    });
    return { ok: true, sessionId: id };
  }

  /** Sends a user turn; a board session that isn't running is resumed first. */
  async send(sessionId: string, text: string): Promise<ActionResult> {
    if (!this.runs.has(sessionId)) {
      const session = this.store.state.sessions[sessionId];
      if (session?.origin !== 'board') return { ok: false, error: NOT_RUNNING };
      const resumed = await this.resumeSession(sessionId);
      if (!resumed.ok) return resumed;
    }
    this.pushPrompt(sessionId, text);
    this.store.setSessionStatus(sessionId, { kind: 'working' }, this.now());
    return { ok: true };
  }

  async interrupt(sessionId: string): Promise<ActionResult> {
    const run = this.runs.get(sessionId);
    if (!run) return { ok: false, error: NOT_RUNNING };
    run.interrupted = true;
    await run.query.interrupt();
    return { ok: true };
  }

  async setModel(sessionId: string, model: string): Promise<ActionResult> {
    const run = this.runs.get(sessionId);
    if (!run) return { ok: false, error: NOT_RUNNING };
    await run.query.setModel(model);
    this.store.updateSession(sessionId, { model }, this.now());
    return { ok: true };
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<ActionResult> {
    const run = this.runs.get(sessionId);
    if (!run) return { ok: false, error: NOT_RUNNING };
    await run.query.setPermissionMode(mode satisfies SdkPermissionMode);
    this.store.updateSession(sessionId, { permissionMode: mode }, this.now());
    return { ok: true };
  }

  /** Ends the session's query; it stays in the store as ended and can be resumed. */
  async close(sessionId: string): Promise<ActionResult> {
    const run = this.runs.get(sessionId);
    if (!run) return { ok: false, error: NOT_RUNNING };
    run.closing = true;
    run.input.end();
    run.query.close();
    await run.done;
    return { ok: true };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.close(id)));
  }

  /** Handles a UI `approval.decide` for a board session's pending approval. */
  decideApproval(decision: ApprovalDecision): ActionResult {
    const pending = this.approvals.get(decision.approvalId);
    if (!pending) return { ok: false, error: UNKNOWN_APPROVAL };
    const { approval, suggestions } = pending;
    const input = isRecord(approval.input) ? approval.input : {};
    if (decision.decision === 'deny') {
      const reason = clipText(decision.reason, REASON_MAX);
      this.settleApproval(pending, 'denied', reason, {
        behavior: 'deny',
        message: reason ?? DENY_MESSAGE,
        ...toolUse(approval),
      });
    } else {
      const always = decision.decision === 'allowAlways' && suggestions.length > 0;
      this.settleApproval(pending, 'allowed', null, {
        behavior: 'allow',
        updatedInput: input,
        ...(always ? { updatedPermissions: suggestions } : {}),
        ...toolUse(approval),
      });
    }
    return { ok: true };
  }

  /** UI action handlers for board sessions. */
  actions(): Pick<
    ActionHandlers,
    | 'session.create'
    | 'session.resume'
    | 'session.interrupt'
    | 'session.close'
    | 'session.setModel'
    | 'session.setPermissionMode'
  > {
    const done = (result: RunnerResult): ActionResult => (result.ok ? { ok: true } : result);
    return {
      'session.create': async ({ projectId, prompt, model, permissionMode }) =>
        done(
          await this.startSession({
            projectId,
            prompt,
            ...(model !== undefined ? { model } : {}),
            ...(permissionMode !== undefined ? { permissionMode } : {}),
          }),
        ),
      'session.resume': async ({ sessionId, projectId, fork }) =>
        done(
          await this.resumeSession(sessionId, {
            ...(projectId !== undefined ? { projectId } : {}),
            ...(fork !== undefined ? { fork } : {}),
          }),
        ),
      'session.interrupt': ({ sessionId }) => this.interrupt(sessionId),
      'session.close': ({ sessionId }) => this.close(sessionId),
      'session.setModel': ({ sessionId, model }) => this.setModel(sessionId, model),
      'session.setPermissionMode': ({ sessionId, permissionMode }) =>
        this.setPermissionMode(sessionId, permissionMode),
    };
  }

  private launch(queryFn: QueryFn, id: string, options: Options): void {
    const input = new MessageQueue<SDKUserMessage>();
    const query = queryFn({
      prompt: input,
      // `settingSources` stays unset: user, project and local settings load like the CLI.
      options: { ...options, includePartialMessages: true, canUseTool: this.canUseTool(id) },
    });
    const run: Run = {
      id,
      query,
      input,
      closing: false,
      interrupted: false,
      draft: null,
      draftTimer: null,
      done: Promise.resolve(),
    };
    this.runs.set(id, run);
    run.done = this.consume(run);
  }

  /**
   * The SDK asks before each tool call the session's rules don't settle. The request becomes
   * a pending `Approval` the board decides; the SDK aborting it (interrupt, close) expires it.
   */
  private canUseTool(runId: string): CanUseTool {
    return (toolName, input, options) => {
      const { signal } = options;
      const deny = (message: string): PermissionResult => ({
        behavior: 'deny',
        message,
        toolUseID: options.toolUseID,
      });
      if (signal.aborted || !this.runs.has(runId)) return Promise.resolve(deny('Cancelled.'));

      const ts = this.now();
      // Suggestions that would grant more than this one call are never offered.
      const suggestions = options.suppressAlwaysAllowRule
        ? []
        : (options.suggestions ?? []).filter((s) => PermissionSuggestion.safeParse(s).success);
      const approval: Approval = {
        id: this.newId(),
        sessionId: runId,
        source: 'sdk',
        tool: toolName,
        input,
        toolUseId: options.toolUseID || null,
        suggestions: suggestions as PermissionSuggestion[],
        blockedPath: options.blockedPath ?? null,
        createdAt: ts,
        expiresAt: this.approvalTimeoutMs === null ? null : ts + this.approvalTimeoutMs,
        state: 'pending',
        decidedAt: null,
        reason: null,
      };

      return new Promise<PermissionResult>((resolve) => {
        const onAbort = () =>
          this.settleApproval(pending, 'expired', 'Cancelled', deny('Cancelled.'));
        const pending: PendingApproval = {
          approval,
          runId,
          suggestions,
          resolve,
          timer: null,
          dispose: () => signal.removeEventListener('abort', onAbort),
        };
        this.approvals.set(approval.id, pending);
        signal.addEventListener('abort', onAbort, { once: true });
        if (this.approvalTimeoutMs !== null) {
          pending.timer = setTimeout(
            () => this.settleApproval(pending, 'expired', 'Timed out', deny('Approval timed out.')),
            this.approvalTimeoutMs,
          );
        }

        this.store.upsertApproval(approval);
        this.refreshApprovalStatus(runId, ts);
        this.onMessage(makeMessage('approval.new', { approval }, { ts }));
        this.activity('permission.request', runId, `${toolName} needs approval`, {
          tool_name: toolName,
          approval_id: approval.id,
        });
      });
    };
  }

  private settleApproval(
    pending: PendingApproval,
    state: 'allowed' | 'denied' | 'expired',
    reason: string | null,
    result: PermissionResult,
  ): void {
    const { approval, runId } = pending;
    if (this.approvals.get(approval.id) !== pending) return;
    this.approvals.delete(approval.id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.dispose();
    const ts = this.now();
    this.store.resolveApproval(approval.id, state, reason, ts);
    this.onMessage(makeMessage('approval.resolved', { approvalId: approval.id, state, reason }));
    this.activity('permission.decision', runId, `${approval.tool} ${state}`, {
      approval_id: approval.id,
      decision: state,
    });
    setTimeout(() => this.store.removeApproval(approval.id), RESOLVED_APPROVAL_TTL_MS).unref();
    this.refreshApprovalStatus(runId, ts, state === 'allowed' ? approval : null);
    pending.resolve(result);
  }

  /**
   * A session waiting on approvals points at its oldest pending one. Once none is left it
   * goes back to the allowed tool, or to working after a denial.
   */
  private refreshApprovalStatus(runId: string, ts: number, allowed: Approval | null = null): void {
    if (!this.runs.has(runId)) return;
    const current = this.status(runId);
    if (!current || current.kind === 'ended') return;
    let oldest: Approval | null = null;
    for (const { approval, runId: owner } of this.approvals.values()) {
      if (owner === runId && (oldest === null || approval.createdAt < oldest.createdAt)) {
        oldest = approval;
      }
    }
    if (oldest) {
      if (current.kind !== 'waiting_permission' || current.approvalId !== oldest.id) {
        this.store.setSessionStatus(
          runId,
          { kind: 'waiting_permission', approvalId: oldest.id },
          ts,
        );
      }
    } else if (current.kind === 'waiting_permission') {
      this.store.setSessionStatus(
        runId,
        allowed
          ? { kind: 'tool', tool: allowed.tool, toolUseId: allowed.toolUseId }
          : { kind: 'working' },
        ts,
      );
    }
  }

  private activity(
    kind: ActivityKind,
    sessionId: string,
    summary: string,
    data: Record<string, unknown>,
  ): void {
    if (!this.onActivity) return;
    this.onActivity({
      id: this.newId(),
      ts: this.now(),
      kind,
      projectId: this.store.state.sessions[sessionId]?.projectId ?? null,
      sessionId,
      terminalId: null,
      execId: null,
      summary,
      data,
    });
  }

  private async consume(run: Run): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of run.query) {
        try {
          this.handle(run, message);
        } catch (err) {
          this.log.warn({ err, sessionId: run.id }, 'skipped sdk message');
        }
      }
    } catch (err) {
      if (!run.closing) {
        failure = err instanceof Error ? clipLine(err.message, 200) : null;
        this.log.warn({ err, sessionId: run.id }, 'board session failed');
      }
    }
    run.input.end();
    this.setDraft(run, null);
    this.runs.delete(run.id);
    for (const pending of [...this.approvals.values()]) {
      if (pending.runId !== run.id) continue;
      this.settleApproval(pending, 'expired', 'Session ended', {
        behavior: 'deny',
        message: 'The session ended before the user decided.',
        ...toolUse(pending.approval),
      });
    }
    this.transcripts?.release(run.id);
    const ts = this.now();
    if (failure !== null || (!run.closing && this.status(run.id)?.kind !== 'idle')) {
      this.store.setSessionStatus(run.id, { kind: 'error', message: failure }, ts);
    } else {
      this.store.setSessionStatus(run.id, { kind: 'ended' }, ts);
    }
  }

  private handle(run: Run, message: SDKMessage): void {
    const base = Base.safeParse(message);
    if (!base.success) return;
    // Subagent traffic belongs to its Task tool call, not the main conversation.
    if (base.data.parent_tool_use_id) return;
    const handlers: Record<string, ((run: Run, message: unknown) => void) | undefined> = {
      system: this.onSystem,
      stream_event: this.onStreamEvent,
      assistant: this.onAssistant,
      user: this.onUser,
      result: this.onResult,
    };
    handlers[base.data.type]?.call(this, run, message);
  }

  private onSystem(run: Run, message: unknown): void {
    const ts = this.now();
    const init = SystemInit.safeParse(message);
    if (init.success) {
      const { model, permissionMode } = init.data;
      this.store.updateSession(
        run.id,
        {
          ...(model ? { model } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        },
        ts,
      );
      return;
    }
    const state = StateChanged.safeParse(message);
    if (state.success) {
      const current = this.status(run.id);
      if (state.data.state === 'idle') {
        this.setDraft(run, null);
        // A failed turn stays visible until the next one starts.
        if (current?.kind !== 'error') this.store.setSessionStatus(run.id, { kind: 'idle' }, ts);
      } else if (state.data.state === 'requires_action') {
        if (current?.kind !== 'waiting_permission') {
          this.store.setSessionStatus(run.id, { kind: 'waiting_permission', approvalId: null }, ts);
        }
      } else if (current && !['working', 'tool', 'compacting'].includes(current.kind)) {
        this.store.setSessionStatus(run.id, { kind: 'working' }, ts);
      }
      return;
    }
    const status = StatusMessage.safeParse(message);
    if (status.success) {
      const current = this.status(run.id);
      if (status.data.permissionMode) {
        this.store.updateSession(run.id, { permissionMode: status.data.permissionMode }, ts);
      }
      if (status.data.status === 'compacting' && current && current.kind !== 'compacting') {
        if (current.kind !== 'ended') {
          this.store.setSessionStatus(run.id, { kind: 'compacting', previous: current }, ts);
        }
      } else if (status.data.status !== 'compacting' && current?.kind === 'compacting') {
        this.store.setSessionStatus(run.id, current.previous, ts);
      }
    }
  }

  private onStreamEvent(run: Run, message: unknown): void {
    const parsed = StreamEvent.safeParse(message);
    if (!parsed.success) return;
    const { event } = parsed.data;
    if (event.type === 'message_start') {
      this.setDraft(run, null);
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      this.setDraft(run, '');
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const text = (run.draft ?? '') + (event.delta.text ?? '');
      this.setDraft(run, text.length > DRAFT_MAX ? text.slice(0, DRAFT_MAX) : text, true);
    }
  }

  private onAssistant(run: Run, message: unknown): void {
    const parsed = AssistantMessage.safeParse(message);
    if (!parsed.success) return;
    this.feed(run, message);
    const ts = this.now();
    let text: string | null = null;
    let tool: z.infer<typeof ToolUseBlock> | null = null;
    for (const block of parsed.data.message.content) {
      const t = TextBlock.safeParse(block);
      if (t.success) text = t.data.text;
      const u = ToolUseBlock.safeParse(block);
      if (u.success) tool = u.data;
    }
    if (text !== null) {
      // The block landed in the transcript; the draft would show it twice.
      this.setDraft(run, null);
      const clipped = clipText(text, TEXT_MAX);
      if (clipped !== null) this.store.updateSession(run.id, { lastAssistantText: clipped }, ts);
    }
    if (tool !== null) {
      const session = this.store.state.sessions[run.id];
      this.store.setSessionStatus(
        run.id,
        { kind: 'tool', tool: tool.name, toolUseId: tool.id },
        ts,
      );
      this.store.updateSession(
        run.id,
        {
          currentTool: {
            id: tool.id,
            sessionId: run.id,
            tool: tool.name,
            family: toolFamily(tool.name),
            summary: toolSummary(tool.input, session?.cwd ?? null),
            startedAt: ts,
            endedAt: null,
            status: 'running',
          },
        },
        ts,
      );
    }
  }

  private onUser(run: Run, message: unknown): void {
    const parsed = UserMessage.safeParse(message);
    if (!parsed.success) return;
    this.feed(run, message);
    const { content } = parsed.data.message;
    const answersTool =
      Array.isArray(content) &&
      content.some((b) => Block.safeParse(b).data?.type === 'tool_result');
    if (answersTool && this.status(run.id)?.kind === 'tool') {
      this.store.setSessionStatus(run.id, { kind: 'working' }, this.now());
    }
  }

  private onResult(run: Run, message: unknown): void {
    const parsed = Result.safeParse(message);
    if (!parsed.success) return;
    this.setDraft(run, null);
    const { subtype, is_error, result, errors } = parsed.data;
    const ts = this.now();
    const interrupted = run.interrupted;
    run.interrupted = false;
    if (subtype === 'success' && is_error !== true) {
      const text = clipText(result, TEXT_MAX);
      if (text !== null) this.store.updateSession(run.id, { lastAssistantText: text }, ts);
      if (this.status(run.id)?.kind !== 'idle') {
        this.store.setSessionStatus(run.id, { kind: 'idle' }, ts);
      }
      return;
    }
    // An interrupt ends the turn with an error result; that isn't a failure.
    if (run.closing) return;
    if (interrupted) {
      this.store.setSessionStatus(run.id, { kind: 'idle' }, ts);
      return;
    }
    const detail = errors?.[0] ?? (is_error ? result : undefined) ?? subtype;
    this.store.setSessionStatus(
      run.id,
      { kind: 'error', message: clipLine(detail, 200) ?? null },
      ts,
    );
  }

  private pushPrompt(id: string, text: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    const uuid = this.newId();
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage['uuid'],
    };
    run.input.push(message);
    // The SDK doesn't echo prompts back; the transcript shows them right away.
    this.feed(run, { ...message, timestamp: new Date(this.now()).toISOString() });
  }

  private feed(run: Run, message: unknown): void {
    if (!this.transcripts) return;
    const entry =
      typeof message === 'object' && message !== null && !('timestamp' in message)
        ? { ...message, timestamp: new Date(this.now()).toISOString() }
        : message;
    this.transcripts.feed(run.id, [entry]);
  }

  /** Streaming text reaches the store at most every `draftIntervalMs`; clearing is immediate. */
  private setDraft(run: Run, text: string | null, throttled = false): void {
    run.draft = text;
    if (throttled) {
      run.draftTimer ??= setTimeout(() => {
        run.draftTimer = null;
        this.writeDraft(run.id, run.draft);
      }, this.draftIntervalMs);
      return;
    }
    if (run.draftTimer) clearTimeout(run.draftTimer);
    run.draftTimer = null;
    this.writeDraft(run.id, text);
  }

  private writeDraft(id: string, draft: string | null): void {
    const session = this.store.state.sessions[id];
    if (!session || (session.draft ?? null) === draft) return;
    this.store.updateSession(id, { draft }, session.updatedAt);
  }

  private status(id: string): ClaudeSession['status'] | undefined {
    return this.store.state.sessions[id]?.status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolUse(approval: Approval): { toolUseID?: string } {
  return approval.toolUseId ? { toolUseID: approval.toolUseId } : {};
}

function isLiveStatus(status: SessionStatus): boolean {
  if (status.kind === 'ended') return false;
  if (status.kind === 'unknown') return status.alive;
  return true;
}

function clipText(text: string | undefined, max: number): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function clipLine(text: string | undefined, max: number): string | null {
  return clipText(text?.replace(/\s+/g, ' '), max);
}

/** The SDK runs Claude Code with the local login; c-board never handles credentials. */
async function loadSdkQuery(): Promise<QueryFn> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return query;
}

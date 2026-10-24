import {
  type Approval,
  type BoardState,
  type ClaudeSession,
  type Execution,
  makeMessage,
  NOTIFY_COALESCE_MS,
  NOTIFY_LONG_RUN_MS,
  type NotifyEvent,
  type PatchOp,
  type PushPayload,
  type ServerToUi,
  type SessionStatus,
  sessionDisplayName,
  toolInputDetail,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { PushSender, PushSubscriptions, SendResult } from './push.js';
import type { BoardStore } from './store.js';

/** A waiting_permission status waits this long for its approval card before pushing on its own. */
export const APPROVAL_GRACE_MS = 1_500;
/** Exit codes of a command the user stopped (SIGINT, SIGTERM): never a crash. */
const INTERRUPTED = new Set([130, 143]);
const TITLE_MAX = 200;
const BODY_MAX = 400;

export interface NotifierSettings {
  events: ReadonlySet<NotifyEvent>;
  hideDetails: boolean;
  muted: ReadonlySet<string>;
  /** Away mode: approval notifications get Allow / Deny actions. */
  away: boolean;
}

export interface NotifierOptions {
  store: BoardStore;
  subscriptions: PushSubscriptions;
  send: PushSender;
  settings: () => NotifierSettings;
  /** Subscriptions whose browser has a board tab visible and focused right now. */
  focused: () => ReadonlySet<string>;
  /** The in-app toast the focused tabs show instead. */
  onMessage?: (message: ServerToUi) => void;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug' | 'info'>;
  now?: () => number;
  longRunMs?: number;
  coalesceMs?: number;
  approvalGraceMs?: number;
}

/** One thing worth a push, before the settings shape it. */
export interface NotifyEventData {
  kind: NotifyEvent;
  projectId: string | null;
  /** What happened, after "acme-shop · ". */
  headline: string;
  body: string;
  /** With Hide details: the only words after the project name. */
  vague: string;
  url: string;
  /** An approval id, or `session:<id>` for a session waiting without one. */
  request: string | null;
  approvalId: string | null;
  level: 'info' | 'success' | 'warning' | 'error';
}

interface SessionShadow {
  kind: SessionStatus['kind'];
  /** When the current turn started, while one runs. */
  busySince: number | null;
  /** Background tasks and subagents still running, as `bg:<id>` / `agent:<id>`. */
  running: Set<string>;
}

interface ProjectSlot {
  lastSentAt: number;
  pending: NotifyEventData | null;
  timer: NodeJS.Timeout | undefined;
  /** The request the project's notification is about now, and who got it. */
  shown: { request: string; to: string[] } | null;
}

const BUSY = new Set<SessionStatus['kind']>([
  'working',
  'tool',
  'compacting',
  'waiting_permission',
]);
const WAITING = new Set<SessionStatus['kind']>(['waiting_permission', 'waiting_input']);
const PRIORITY: Record<NotifyEvent, number> = {
  needs_you: 3,
  crashed: 2,
  claude_finished: 1,
  command_finished: 1,
  background: 0,
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const firstLine = (text: string | null | undefined) =>
  (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 === 0 ? `${min}m` : `${min}m ${sec % 60}s`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}m`;
}

const encode = encodeURIComponent;
const sessionUrl = (projectId: string | null, sessionId: string) =>
  projectId ? `/#/p/${encode(projectId)}/s/${encode(sessionId)}` : '/#/attention';
const terminalUrl = (projectId: string | null, terminalId: string) =>
  projectId ? `/#/p/${encode(projectId)}/t/${encode(terminalId)}` : '/';

/**
 * Push notifications (12.6e3). Watches the board's patches for the events Settings turns on
 * (Claude needs you, a long turn or command finished, a crash, background work done), then pushes
 * them to every subscribed browser but the ones looking at the board, at most one per project per
 * 20 s (later events replace it by `tag`), and closes a request's notification once it is answered.
 */
export class Notifier {
  private readonly now: () => number;
  private readonly longRunMs: number;
  private readonly coalesceMs: number;
  private readonly graceMs: number;
  private readonly sessions = new Map<string, SessionShadow>();
  private readonly runningExecs = new Set<string>();
  /** Running executions that served a port: their failure is a dev server crashing. */
  private readonly serverExecs = new Set<string>();
  private readonly seenApprovals = new Set<string>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly slots = new Map<string, ProjectSlot>();
  private readonly detach: () => void;

  constructor(private readonly options: NotifierOptions) {
    this.now = options.now ?? Date.now;
    this.longRunMs = options.longRunMs ?? NOTIFY_LONG_RUN_MS;
    this.coalesceMs = options.coalesceMs ?? NOTIFY_COALESCE_MS;
    this.graceMs = options.approvalGraceMs ?? APPROVAL_GRACE_MS;
    // What is already on the board when it starts is history: only changes push.
    const { state } = options.store;
    for (const session of Object.values(state.sessions)) {
      this.sessions.set(session.id, this.shadowOf(session, undefined));
    }
    for (const exec of Object.values(state.executions)) {
      if (exec.endedAt === null) this.runningExecs.add(exec.id);
    }
    for (const approval of Object.values(state.approvals)) this.seenApprovals.add(approval.id);
    this.detach = options.store.onPatch((ops) => this.onPatch(ops));
  }

  stop(): void {
    this.detach();
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    for (const slot of this.slots.values()) clearTimeout(slot.timer);
    this.slots.clear();
  }

  /** The Settings "Send a test" push; it skips every rule. */
  test(subscriptionId: string): Promise<SendResult> {
    const subscription = this.options.subscriptions.get(subscriptionId);
    if (!subscription) return Promise.resolve({ ok: false, gone: true, status: null });
    return this.options.send(
      subscription,
      {
        type: 'show',
        kind: 'test',
        title: 'Yardmaster · Test notification',
        body: 'Notifications reach this device.',
        tag: 'test',
        url: '/',
        request: null,
        approvalId: null,
        ts: this.now(),
      },
      { urgency: 'normal' },
    );
  }

  private onPatch(ops: readonly PatchOp[]): void {
    const changed = {
      sessions: new Set<string>(),
      executions: new Set<string>(),
      approvals: new Set<string>(),
      ports: false,
    };
    const { state } = this.options.store;
    for (const op of ops) {
      const [collection, id] = op.path;
      if (collection === 'ports') {
        changed.ports = true;
        continue;
      }
      if (collection !== 'sessions' && collection !== 'executions' && collection !== 'approvals')
        continue;
      const ids = changed[collection];
      if (id !== undefined) ids.add(id);
      else for (const key of Object.keys(state[collection])) ids.add(key);
    }
    if (changed.ports) this.notePorts(state);
    for (const id of changed.approvals) this.onApproval(id, state.approvals[id]);
    for (const id of changed.sessions) this.onSession(id, state.sessions[id]);
    for (const id of changed.executions) this.onExecution(id, state.executions[id]);
  }

  private shadowOf(session: ClaudeSession, previous: SessionShadow | undefined): SessionShadow {
    const busy = BUSY.has(session.status.kind);
    const wasBusy = previous !== undefined && BUSY.has(previous.kind);
    return {
      kind: session.status.kind,
      busySince: busy ? (wasBusy ? (previous?.busySince ?? null) : session.updatedAt) : null,
      running: new Set([
        ...(session.background ?? [])
          .filter((t) => t.status === 'running')
          .map((t) => `bg:${t.id}`),
        ...session.subagents.filter((a) => a.status === 'running').map((a) => `agent:${a.id}`),
      ]),
    };
  }

  private onSession(id: string, session: ClaudeSession | undefined): void {
    const previous = this.sessions.get(id);
    if (!session) {
      this.sessions.delete(id);
      this.cancelGrace(id);
      this.answered(`session:${id}`);
      return;
    }
    const next = this.shadowOf(session, previous);
    this.sessions.set(id, next);
    const kind = next.kind;
    const prevKind = previous?.kind;

    if (prevKind !== undefined && WAITING.has(prevKind) && kind !== prevKind) {
      this.cancelGrace(id);
      this.answered(`session:${id}`);
    }
    if (kind === 'waiting_input' && prevKind !== 'waiting_input') {
      this.emit(this.needsEvent(session, null));
    } else if (kind === 'waiting_permission' && prevKind !== 'waiting_permission') {
      this.waitForApproval(session);
    }

    if (
      kind === 'idle' &&
      previous?.busySince != null &&
      this.now() - previous.busySince >= this.longRunMs
    ) {
      this.emit(this.finishedEvent(session, this.now() - previous.busySince));
    }

    if (previous) {
      for (const key of previous.running) {
        if (!next.running.has(key)) this.emitBackgroundDone(session, key);
      }
    }
  }

  /** A terminal's own permission prompt has no approval card; one from away mode comes next. */
  private waitForApproval(session: ClaudeSession): void {
    const status = session.status;
    if (status.kind === 'waiting_permission' && status.approvalId !== null) return;
    this.cancelGrace(session.id);
    this.graceTimers.set(
      session.id,
      setTimeout(() => {
        this.graceTimers.delete(session.id);
        const current = this.options.store.state.sessions[session.id];
        if (current?.status.kind !== 'waiting_permission') return;
        const approvalId = current.status.approvalId;
        if (approvalId !== null && this.options.store.state.approvals[approvalId]) return;
        this.emit(this.needsEvent(current, null));
      }, this.graceMs),
    );
  }

  private cancelGrace(sessionId: string): void {
    clearTimeout(this.graceTimers.get(sessionId));
    this.graceTimers.delete(sessionId);
  }

  private onApproval(id: string, approval: Approval | undefined): void {
    if (approval?.state !== 'pending') {
      this.answered(id);
      return;
    }
    if (this.seenApprovals.has(id)) return;
    this.seenApprovals.add(id);
    this.cancelGrace(approval.sessionId);
    const session = this.options.store.state.sessions[approval.sessionId];
    if (session) this.emit(this.needsEvent(session, approval));
  }

  private notePorts(state: BoardState): void {
    for (const port of Object.values(state.ports)) {
      if (port.terminalId === null) continue;
      const terminal = state.terminals[port.terminalId];
      const execId = terminal?.executionIds.at(-1);
      if (execId && this.runningExecs.has(execId)) this.serverExecs.add(execId);
    }
  }

  private onExecution(id: string, exec: Execution | undefined): void {
    if (!exec) {
      this.runningExecs.delete(id);
      this.serverExecs.delete(id);
      return;
    }
    if (exec.endedAt === null) {
      this.runningExecs.add(id);
      return;
    }
    if (!this.runningExecs.delete(id)) return;
    const server = this.serverExecs.delete(id);
    const event = this.execEvent(exec, server);
    if (event) this.emit(event);
  }

  private execEvent(exec: Execution, server: boolean): NotifyEventData | null {
    const { state } = this.options.store;
    const projectId = state.terminals[exec.terminalId]?.projectId ?? null;
    const command = clip(firstLine(exec.commandLine) || 'A command', 80);
    const ran = formatDuration((exec.endedAt ?? this.now()) - exec.startedAt);
    const code = exec.exitCode;
    const url = terminalUrl(projectId, exec.terminalId);
    // The user stopped it: they know.
    if (code !== null && INTERRUPTED.has(code)) return null;
    const failed = code !== null && code !== 0;
    // A dev server going down, or a process killed by a signal (a segfault, the OOM killer).
    if (failed && (server || code > 128)) {
      return {
        kind: 'crashed',
        projectId,
        headline: `${command} crashed`,
        body: `Exit code ${code} after ${ran}`,
        vague: 'something crashed',
        url,
        request: null,
        approvalId: null,
        level: 'error',
      };
    }
    const duration = (exec.endedAt ?? this.now()) - exec.startedAt;
    if (duration < this.longRunMs || exec.interactive) return null;
    return {
      kind: 'command_finished',
      projectId,
      headline: code === null || code === 0 ? `✓ ${command}` : `${command} exited ${code}`,
      body: `Ran for ${ran}`,
      vague: 'a command finished',
      url,
      request: null,
      approvalId: null,
      level: code === null || code === 0 ? 'success' : 'warning',
    };
  }

  private needsEvent(session: ClaudeSession, approval: Approval | null): NotifyEventData {
    const name = sessionDisplayName(session);
    const url = sessionUrl(session.projectId, session.id);
    if (approval) {
      return {
        kind: 'needs_you',
        projectId: session.projectId,
        headline: `${name} wants to run ${approval.tool}`,
        body: toolInputDetail(approval.input)?.trim() ?? '',
        vague: 'needs you',
        url,
        request: approval.id,
        approvalId: approval.id,
        level: 'warning',
      };
    }
    const input = session.status.kind === 'waiting_input';
    return {
      kind: 'needs_you',
      projectId: session.projectId,
      headline: input ? `${name} is waiting for you` : `${name} needs your approval`,
      body: input ? firstLine(session.lastAssistantText) : 'Answer the prompt in its terminal.',
      vague: 'needs you',
      url,
      request: `session:${session.id}`,
      approvalId: null,
      level: 'warning',
    };
  }

  private finishedEvent(session: ClaudeSession, ms: number): NotifyEventData {
    const reply = firstLine(session.lastAssistantText);
    return {
      kind: 'claude_finished',
      projectId: session.projectId,
      headline: `${sessionDisplayName(session)} finished`,
      body: reply || `Worked for ${formatDuration(ms)}`,
      vague: 'Claude finished',
      url: sessionUrl(session.projectId, session.id),
      request: null,
      approvalId: null,
      level: 'success',
    };
  }

  private emitBackgroundDone(session: ClaudeSession, key: string): void {
    const [type, ...rest] = key.split(':');
    const id = rest.join(':');
    let headline: string;
    let body = '';
    if (type === 'bg') {
      const task = session.background?.find((t) => t.id === id);
      headline =
        task?.status === 'error' ? 'A background task failed' : 'A background task finished';
      body = task?.label ?? '';
    } else {
      const agent = session.subagents.find((a) => a.id === id);
      headline = agent?.status === 'error' ? 'A subagent failed' : 'A subagent finished';
      body = agent?.description ?? agent?.type ?? '';
    }
    this.emit({
      kind: 'background',
      projectId: session.projectId,
      headline,
      body,
      vague: 'background work finished',
      url: sessionUrl(session.projectId, session.id),
      request: null,
      approvalId: null,
      level: 'info',
    });
  }

  private emit(event: NotifyEventData): void {
    const settings = this.options.settings();
    if (!settings.events.has(event.kind)) return;
    if (event.projectId !== null && settings.muted.has(event.projectId)) return;
    if (this.options.subscriptions.list().length === 0) return;
    // Approvals already toast on the board; the rest toast here for the tabs that skip the push.
    if (event.approvalId === null) this.options.onMessage?.(this.toast(event));

    const key = event.projectId ?? '';
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { lastSentAt: -Infinity, pending: null, timer: undefined, shown: null };
      this.slots.set(key, slot);
    }
    const now = this.now();
    if (slot.timer === undefined && now - slot.lastSentAt >= this.coalesceMs) {
      this.deliver(key, slot, event);
      return;
    }
    if (!slot.pending || PRIORITY[event.kind] >= PRIORITY[slot.pending.kind]) slot.pending = event;
    if (slot.timer === undefined) {
      const owner = slot;
      owner.timer = setTimeout(
        () => {
          owner.timer = undefined;
          const next = owner.pending;
          owner.pending = null;
          if (next) this.deliver(key, owner, next);
        },
        Math.max(0, slot.lastSentAt + this.coalesceMs - now),
      );
    }
  }

  /** A request was answered on the board or in the terminal: drop it and close its notification. */
  private answered(request: string): void {
    for (const [key, slot] of this.slots) {
      if (slot.pending?.request === request) {
        slot.pending = null;
        clearTimeout(slot.timer);
        slot.timer = undefined;
      }
      if (slot.shown?.request !== request) continue;
      const { to } = slot.shown;
      slot.shown = null;
      const payload: PushPayload = { type: 'close', tag: this.tag(key), request };
      for (const id of to) {
        const subscription = this.options.subscriptions.get(id);
        if (subscription) void this.sendTo(subscription, payload, 'normal');
      }
    }
  }

  private tag(key: string): string {
    return `project:${key || 'board'}`;
  }

  private deliver(key: string, slot: ProjectSlot, event: NotifyEventData): void {
    const settings = this.options.settings();
    const label = this.projectLabel(event.projectId);
    const hide = settings.hideDetails;
    const title =
      hide && event.kind === 'needs_you'
        ? `${label} needs you`
        : `${label} · ${hide ? event.vague : event.headline}`;
    const payload: PushPayload = {
      type: 'show',
      kind: event.kind,
      title: clip(title, TITLE_MAX),
      body: hide ? '' : clip(event.body, BODY_MAX),
      tag: this.tag(key),
      url: event.url,
      request: event.request,
      // Deciding blind is not an option: no actions without the details.
      approvalId: settings.away && !hide ? event.approvalId : null,
      ts: this.now(),
    };
    slot.lastSentAt = this.now();
    const focused = this.options.focused();
    const to: string[] = [];
    for (const subscription of this.options.subscriptions.list()) {
      if (focused.has(subscription.id)) continue;
      to.push(subscription.id);
      void this.sendTo(subscription, payload, event.kind === 'needs_you' ? 'high' : 'normal');
    }
    slot.shown = event.request ? { request: event.request, to } : null;
    this.options.logger.debug({ kind: event.kind, devices: to.length }, 'push notification');
  }

  private async sendTo(
    subscription: { id: string },
    payload: PushPayload,
    urgency: 'high' | 'normal',
  ): Promise<void> {
    const current = this.options.subscriptions.get(subscription.id);
    if (!current) return;
    let result: SendResult;
    try {
      result = await this.options.send(current, payload, { urgency });
    } catch {
      result = { ok: false, gone: false, status: null };
    }
    if (result.ok) {
      if (payload.type === 'show') this.options.subscriptions.markSent(current.id);
      return;
    }
    if (result.gone) {
      this.options.subscriptions.remove(current.id);
      this.options.logger.info('dropped an expired push subscription');
      return;
    }
    this.options.logger.warn({ status: result.status }, 'a push notification was not delivered');
  }

  private projectLabel(projectId: string | null): string {
    return (
      (projectId ? this.options.store.state.projects[projectId]?.name : undefined) ?? 'Yardmaster'
    );
  }

  private toast(event: NotifyEventData): ServerToUi {
    return makeMessage('toast', {
      level: event.level,
      title: clip(`${this.projectLabel(event.projectId)} · ${event.headline}`, TITLE_MAX),
      ...(event.body ? { body: clip(event.body, 400) } : {}),
      ...(event.projectId ? { projectId: event.projectId } : {}),
    });
  }
}

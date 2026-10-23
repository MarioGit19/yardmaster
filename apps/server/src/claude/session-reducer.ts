import {
  type BackgroundTask,
  backgroundCommand,
  backgroundLabel,
  backgroundLaunchKind,
  backgroundTaskIdOf,
  type ClaudeSession,
  endBackground,
  type HookCommon,
  type KnownHookEvent,
  PermissionMode,
  parseLiveTasks,
  reconcileBackground,
  type SessionStatus,
  type Subagent,
  sameTaskId,
  startBackground,
  stopAllBackground,
  type ToolActivity,
  toolFamily,
  toolInputDetail,
} from '@c-board/protocol';

/** One hook delivery, already parsed. `hook` is null for events we don't recognise. */
export interface SessionHookEvent {
  common: HookCommon;
  hook: KnownHookEvent | null;
  ts: number;
  claudePid?: number | null;
  projectId?: string | null;
}

export const MAX_SUBAGENTS = 20;
const TEXT_MAX = 4_000;
const TITLE_MAX = 120;
const DETAIL_MAX = 200;

export function newSession(id: string, ts: number): ClaudeSession {
  return {
    id,
    origin: 'terminal',
    projectId: null,
    cwd: null,
    status: { kind: 'unknown', alive: true },
    title: null,
    model: null,
    permissionMode: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: null,
    currentTool: null,
    todos: [],
    subagents: [],
    terminalId: null,
    claudePid: null,
    transcriptPath: null,
    lastAssistantText: null,
    startedAt: ts,
    updatedAt: ts,
    endedAt: null,
  };
}

/**
 * The status state machine of PRD §4.2, driven by Claude Code hook events. Pure: returns
 * a new session (or a fresh one when `session` is undefined) and never mutates its input.
 */
export function sessionReducer(
  session: ClaudeSession | undefined,
  event: SessionHookEvent,
): ClaudeSession {
  const { common, hook, ts } = event;
  const base = session ?? newSession(common.session_id, ts);
  const mode = PermissionMode.safeParse(common.permission_mode);
  let next: ClaudeSession = {
    ...base,
    cwd: common.cwd ?? base.cwd,
    transcriptPath: common.transcript_path ?? base.transcriptPath,
    permissionMode: mode.success ? mode.data : base.permissionMode,
    claudePid: event.claudePid ?? base.claudePid,
    projectId: event.projectId ?? base.projectId,
    updatedAt: Math.max(base.updatedAt, ts),
  };
  if (!hook) return next;

  const status = next.status;
  const ended = status.kind === 'ended';
  const to = (target: SessionStatus): ClaudeSession => withStatus(next, target, ts);

  // Its process is gone with the old server: a late hook (its SessionEnd) changes nothing.
  if (status.kind === 'interrupted' && hook.hook_event_name !== 'SessionStart') return next;

  switch (hook.hook_event_name) {
    case 'SessionStart':
      next = { ...next, model: hook.model ?? next.model, endedAt: null };
      // A compaction restarts the session mid-turn; PostCompact restores the status.
      return status.kind === 'compacting' ? next : to({ kind: 'idle' });

    case 'SessionEnd':
      return to({ kind: 'ended' });

    case 'UserPromptSubmit':
      if (ended) return next;
      if (next.title === null) next = { ...next, title: clipLine(hook.prompt, TITLE_MAX) };
      // The previous turn's answer is not this turn's.
      next = { ...next, lastAssistantText: null, lastAssistantAt: null };
      return to({ kind: 'working' });

    case 'PreToolUse': {
      if (ended) return next;
      const toolUseId = hook.tool_use_id ?? null;
      const current: ToolActivity = {
        id: toolUseId ?? `${hook.session_id}:${ts}`,
        sessionId: next.id,
        tool: hook.tool_name,
        family: toolFamily(hook.tool_name),
        summary: toolSummary(hook.tool_input, next.cwd),
        startedAt: ts,
        endedAt: null,
        status: 'running',
      };
      next = to({ kind: 'tool', tool: hook.tool_name, toolUseId });
      return { ...next, currentTool: current };
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const id = hook.tool_use_id ?? null;
      next = withLaunch(next, hook, ts);
      const finishesTool =
        status.kind === 'tool' &&
        (id === null || status.toolUseId === null || status.toolUseId === id);
      // Late or parallel results must not pull an idle session back to work.
      const resumes =
        finishesTool || ['working', 'waiting_permission', 'unknown'].includes(status.kind);
      return resumes ? to({ kind: 'working' }) : next;
    }

    case 'Notification':
      if (ended) return next;
      if (hook.notification_type === 'permission_prompt') {
        return to({ kind: 'waiting_permission', approvalId: null });
      }
      if (hook.notification_type === 'idle_prompt') return to({ kind: 'waiting_input' });
      return next;

    case 'PermissionRequest':
      if (ended) return next;
      return to({ kind: 'waiting_permission', approvalId: null });

    case 'Stop':
      next = withAssistantText(next, hook.last_assistant_message, ts);
      next = withLiveTasks(next, hook.background_tasks, ts);
      return ended ? next : to({ kind: 'idle' });

    case 'StopFailure':
      next = withAssistantText(next, hook.last_assistant_message, ts);
      return ended
        ? next
        : to({ kind: 'error', message: errorMessage(hook.error_details, hook.error) });

    case 'PreCompact':
      if (status.kind === 'ended' || status.kind === 'compacting') return next;
      if (status.kind === 'interrupted') return next;
      return to({ kind: 'compacting', previous: status });

    case 'PostCompact':
      return status.kind === 'compacting' ? to(status.previous) : next;

    case 'SubagentStart':
      return {
        ...next,
        subagents: startSubagent(
          next.subagents,
          hook.agent_id,
          hook.agent_type,
          ts,
          subagentDescription(next, hook.agent_id),
        ),
      };

    case 'SubagentStop': {
      next = withLiveTasks(next, hook.background_tasks, ts);
      const agentId = hook.agent_id;
      const background = next.background ?? [];
      return {
        ...next,
        subagents: stopSubagent(next.subagents, agentId, hook.agent_type, ts),
        ...(agentId !== undefined && background.some((t) => sameTaskId(t.id, agentId))
          ? {
              background: background.map((task) =>
                task.kind === 'agent' && sameTaskId(task.id, agentId)
                  ? endBackground(task, { status: 'done', ts })
                  : task,
              ),
            }
          : {}),
      };
    }
  }
}

type ToolResultHook = Extract<
  KnownHookEvent,
  { hook_event_name: 'PostToolUse' | 'PostToolUseFailure' }
>;

/** A tool call that left work running in the background adds it to the session's list. */
function withLaunch(session: ClaudeSession, hook: ToolResultHook, ts: number): ClaudeSession {
  const failed = hook.hook_event_name === 'PostToolUseFailure';
  const response = failed ? undefined : hook.tool_response;
  const kind = backgroundLaunchKind(hook.tool_name, hook.tool_input, response);
  if (kind === null) return session;
  const toolUseId = hook.tool_use_id ?? null;
  const id = backgroundTaskIdOf(response) ?? toolUseId ?? `bg-${ts}`;
  const background = startBackground(session.background ?? [], {
    id,
    kind,
    label: backgroundLabel(hook.tool_input),
    command: backgroundCommand(hook.tool_input),
    toolUseId,
    ts,
    // It never started: shown as failed, not as running.
    ...(failed ? { status: 'error' as const } : {}),
  });
  let subagents = session.subagents;
  if (kind === 'agent' && !failed) {
    const description = backgroundLabel(hook.tool_input);
    subagents = subagents.map((agent) =>
      agent.description === null && sameTaskId(agent.id, id) ? { ...agent, description } : agent,
    );
  }
  return { ...session, background, subagents };
}

/** A `background_tasks` snapshot (Stop, SubagentStop) is the full live set: reconcile with it. */
function withLiveTasks(session: ClaudeSession, raw: unknown, ts: number): ClaudeSession {
  const live = parseLiveTasks(raw);
  if (live === null) return session;
  const background = session.background ?? [];
  if (live.length === 0 && !background.some((t) => t.status === 'running')) return session;
  return { ...session, background: reconcileBackground(background, live, ts) };
}

/** What a new subagent is doing: its async launch's label, else the Agent call in flight. */
function subagentDescription(session: ClaudeSession, agentId: string | undefined): string | null {
  if (agentId !== undefined) {
    const task = session.background?.find(
      (t: BackgroundTask) => t.kind === 'agent' && sameTaskId(t.id, agentId),
    );
    if (task) return task.label;
  }
  const tool = session.currentTool;
  return tool?.family === 'task' && tool.status === 'running' ? tool.summary : null;
}

function withAssistantText(
  session: ClaudeSession,
  message: string | undefined,
  ts: number,
): ClaudeSession {
  const text = clipText(message);
  return text === null ? session : { ...session, lastAssistantText: text, lastAssistantAt: ts };
}

function withStatus(session: ClaudeSession, status: SessionStatus, ts: number): ClaudeSession {
  const next: ClaudeSession = { ...session, status };
  // Keep the tool visible while it waits for a permission decision.
  if (status.kind !== 'tool' && status.kind !== 'waiting_permission') next.currentTool = null;
  if (status.kind === 'ended') {
    next.endedAt = session.endedAt ?? ts;
    if (session.background) next.background = [...stopAllBackground(session.background, ts)];
  } else if (status.kind !== 'compacting') next.endedAt = null;
  return next;
}

function startSubagent(
  list: readonly Subagent[],
  id: string | undefined,
  type: string | undefined,
  ts: number,
  description: string | null,
): Subagent[] {
  const agentId = id ?? `subagent-${ts}`;
  if (list.some((agent) => agent.id === agentId)) return [...list];
  const agent: Subagent = {
    id: agentId,
    type: type ?? null,
    description,
    status: 'running',
    startedAt: ts,
    endedAt: null,
  };
  return [...list.slice(-(MAX_SUBAGENTS - 1)), agent];
}

function stopSubagent(
  list: readonly Subagent[],
  id: string | undefined,
  type: string | undefined,
  ts: number,
): Subagent[] {
  // Without an id, close the oldest running subagent of the same type.
  const match =
    id !== undefined
      ? list.find((agent) => agent.id === id)
      : list.find(
          (agent) => agent.status === 'running' && (type === undefined || agent.type === type),
        );
  if (!match) return [...list];
  return list.map((agent) =>
    agent === match && agent.status === 'running'
      ? { ...agent, status: 'done', endedAt: ts }
      : agent,
  );
}

export function toolSummary(input: unknown, cwd: string | null): string | null {
  let detail = toolInputDetail(input);
  if (detail === undefined) return null;
  if (cwd && detail.startsWith(`${cwd.replace(/\/+$/, '')}/`)) {
    detail = detail.slice(cwd.replace(/\/+$/, '').length + 1);
  }
  return clipLine(detail, DETAIL_MAX);
}

function errorMessage(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const text = clipLine(candidate, DETAIL_MAX);
      if (text) return text;
    }
    if (typeof candidate === 'object' && candidate !== null) {
      const message = (candidate as Record<string, unknown>).message;
      if (typeof message === 'string') {
        const text = clipLine(message, DETAIL_MAX);
        if (text) return text;
      }
    }
  }
  return null;
}

function clipText(text: string | undefined, max = TEXT_MAX): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Collapses whitespace to a single line before clipping. */
function clipLine(text: string | undefined, max: number): string | null {
  return clipText(text?.replace(/\s+/g, ' '), max);
}

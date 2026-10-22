import {
  type ClaudeSession,
  type HookCommon,
  type KnownHookEvent,
  PermissionMode,
  type SessionStatus,
  type Subagent,
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
      next = {
        ...next,
        lastAssistantText: clipText(hook.last_assistant_message) ?? next.lastAssistantText,
      };
      return ended ? next : to({ kind: 'idle' });

    case 'StopFailure':
      next = {
        ...next,
        lastAssistantText: clipText(hook.last_assistant_message) ?? next.lastAssistantText,
      };
      return ended
        ? next
        : to({ kind: 'error', message: errorMessage(hook.error_details, hook.error) });

    case 'PreCompact':
      if (status.kind === 'ended' || status.kind === 'compacting') return next;
      return to({ kind: 'compacting', previous: status });

    case 'PostCompact':
      return status.kind === 'compacting' ? to(status.previous) : next;

    case 'SubagentStart':
      return {
        ...next,
        subagents: startSubagent(next.subagents, hook.agent_id, hook.agent_type, ts),
      };

    case 'SubagentStop':
      return {
        ...next,
        subagents: stopSubagent(next.subagents, hook.agent_id, hook.agent_type, ts),
      };
  }
}

function withStatus(session: ClaudeSession, status: SessionStatus, ts: number): ClaudeSession {
  const next: ClaudeSession = { ...session, status };
  // Keep the tool visible while it waits for a permission decision.
  if (status.kind !== 'tool' && status.kind !== 'waiting_permission') next.currentTool = null;
  if (status.kind === 'ended') next.endedAt = session.endedAt ?? ts;
  else if (status.kind !== 'compacting') next.endedAt = null;
  return next;
}

function startSubagent(
  list: readonly Subagent[],
  id: string | undefined,
  type: string | undefined,
  ts: number,
): Subagent[] {
  const agentId = id ?? `subagent-${ts}`;
  if (list.some((agent) => agent.id === agentId)) return [...list];
  const agent: Subagent = {
    id: agentId,
    type: type ?? null,
    description: null,
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

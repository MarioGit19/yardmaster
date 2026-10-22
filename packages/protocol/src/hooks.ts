import { z } from 'zod';
import {
  type ActivityEvent,
  type ActivityKind,
  Pid,
  Timestamp,
  type ToolFamily,
} from './domain.js';

// Claude Code hook stdin payloads, PRD §6.1. Schemas are permissive: unknown fields pass
// through and event-specific fields are optional, because the payloads change between
// Claude Code versions and must never be rejected for carrying more than we expect.

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
] as const;
export const HookEventName = z.enum(HOOK_EVENT_NAMES);
export type HookEventName = z.infer<typeof HookEventName>;

const Str = z.string().max(100_000);

export const HookCommon = z
  .object({
    session_id: z.string().min(1).max(256),
    transcript_path: Str.optional(),
    cwd: Str.optional(),
    permission_mode: z.string().max(64).optional(),
    hook_event_name: z.string().min(1).max(128),
  })
  .passthrough();
export type HookCommon = z.infer<typeof HookCommon>;

function hook<E extends HookEventName, S extends z.ZodRawShape>(event: E, shape: S) {
  return HookCommon.extend({ hook_event_name: z.literal(event), ...shape }).passthrough();
}

const ToolFields = {
  tool_name: z.string().min(1).max(256),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().max(256).optional(),
};

export const SessionStartHook = hook('SessionStart', {
  source: z.string().max(64).optional(),
  model: z.string().max(256).optional(),
  agent_type: z.string().max(256).optional(),
});
export const SessionEndHook = hook('SessionEnd', { reason: z.string().max(256).optional() });
export const UserPromptSubmitHook = hook('UserPromptSubmit', { prompt: Str.optional() });
export const PreToolUseHook = hook('PreToolUse', ToolFields);
export const PostToolUseHook = hook('PostToolUse', {
  ...ToolFields,
  tool_response: z.unknown().optional(),
});
export const PostToolUseFailureHook = hook('PostToolUseFailure', {
  ...ToolFields,
  error: z.unknown().optional(),
  is_interrupt: z.boolean().optional(),
});
export const NotificationHook = hook('Notification', {
  message: Str.optional(),
  title: Str.optional(),
  notification_type: z.string().max(128).optional(),
});
export const StopHook = hook('Stop', {
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: Str.optional(),
});
export const StopFailureHook = hook('StopFailure', {
  error: z.unknown().optional(),
  error_details: z.unknown().optional(),
  last_assistant_message: Str.optional(),
});
export const SubagentStartHook = hook('SubagentStart', {
  agent_id: z.string().max(256).optional(),
  agent_type: z.string().max(256).optional(),
});
export const SubagentStopHook = hook('SubagentStop', {
  stop_hook_active: z.boolean().optional(),
  agent_id: z.string().max(256).optional(),
  agent_type: z.string().max(256).optional(),
  agent_transcript_path: Str.optional(),
  last_assistant_message: Str.optional(),
});
export const PreCompactHook = hook('PreCompact', {
  trigger: z.string().max(64).optional(),
  custom_instructions: Str.nullable().optional(),
});
export const PostCompactHook = hook('PostCompact', {
  trigger: z.string().max(64).optional(),
  compact_summary: Str.optional(),
});
export const PermissionRequestHook = hook('PermissionRequest', {
  ...ToolFields,
  permission_suggestions: z.array(z.unknown()).optional(),
});

export const KnownHookEvent = z.discriminatedUnion('hook_event_name', [
  SessionStartHook,
  SessionEndHook,
  UserPromptSubmitHook,
  PreToolUseHook,
  PostToolUseHook,
  PostToolUseFailureHook,
  NotificationHook,
  StopHook,
  StopFailureHook,
  SubagentStartHook,
  SubagentStopHook,
  PreCompactHook,
  PostCompactHook,
  PermissionRequestHook,
]);
export type KnownHookEvent = z.infer<typeof KnownHookEvent>;

const HOOK_KIND: Record<HookEventName, ActivityKind> = {
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool.start',
  PostToolUse: 'tool.end',
  PostToolUseFailure: 'tool.error',
  Notification: 'notification',
  Stop: 'stop',
  StopFailure: 'stop.failure',
  SubagentStart: 'subagent.start',
  SubagentStop: 'subagent.stop',
  PreCompact: 'compact.start',
  PostCompact: 'compact.end',
  PermissionRequest: 'permission.request',
};

const SUMMARY_MAX = 200;

function clip(text: string | undefined | null): string | null {
  if (!text) return null;
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** The most telling `tool_input` field (command, file path, pattern, …), or undefined. */
export function toolInputDetail(input: unknown): string | undefined {
  return (
    field(input, 'command') ??
    field(input, 'file_path') ??
    field(input, 'notebook_path') ??
    field(input, 'pattern') ??
    field(input, 'url') ??
    field(input, 'query') ??
    field(input, 'description') ??
    field(input, 'path')
  );
}

/** Short caption for a tool call, e.g. `Bash: pnpm test` or `Edit: src/cart.ts`. */
export function summarizeToolInput(tool: string, input: unknown): string {
  const detail = toolInputDetail(input);
  return clip(detail ? `${tool}: ${detail}` : tool) ?? tool;
}

const TOOL_FAMILIES: Record<string, ToolFamily> = {
  Bash: 'bash',
  BashOutput: 'bash',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'task',
  Agent: 'task',
  TodoWrite: 'todo',
};

export function toolFamily(tool: string): ToolFamily {
  return Object.hasOwn(TOOL_FAMILIES, tool) ? (TOOL_FAMILIES[tool] as ToolFamily) : 'other';
}

function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  return field(error, 'message');
}

function describeHook(event: KnownHookEvent): {
  summary: string | null;
  data: Record<string, unknown>;
} {
  switch (event.hook_event_name) {
    case 'SessionStart':
      return {
        summary: clip(event.source ? `Session ${event.source}` : 'Session start'),
        data: { source: event.source ?? null, model: event.model ?? null },
      };
    case 'SessionEnd':
      return {
        summary: clip(event.reason ? `Session end (${event.reason})` : 'Session end'),
        data: { reason: event.reason ?? null },
      };
    case 'UserPromptSubmit':
      return { summary: clip(event.prompt), data: { prompt: event.prompt ?? null } };
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PermissionRequest':
      return {
        summary: summarizeToolInput(event.tool_name, event.tool_input),
        data: {
          tool: event.tool_name,
          toolUseId: event.tool_use_id ?? null,
          toolInput: event.tool_input ?? null,
        },
      };
    case 'PostToolUseFailure':
      return {
        summary: summarizeToolInput(event.tool_name, event.tool_input),
        data: {
          tool: event.tool_name,
          toolUseId: event.tool_use_id ?? null,
          toolInput: event.tool_input ?? null,
          error: clip(errorText(event.error)),
          interrupted: event.is_interrupt ?? false,
        },
      };
    case 'Notification':
      return {
        summary: clip(event.message ?? event.title),
        data: {
          notificationType: event.notification_type ?? null,
          message: event.message ?? null,
        },
      };
    case 'Stop':
      return {
        summary: clip(event.last_assistant_message) ?? 'Stopped',
        data: { lastAssistantMessage: event.last_assistant_message ?? null },
      };
    case 'StopFailure': {
      const error = clip(errorText(event.error));
      return { summary: error ?? 'Turn failed', data: { error } };
    }
    case 'SubagentStart':
    case 'SubagentStop':
      return {
        summary: clip(event.agent_type) ?? 'Subagent',
        data: { agentId: event.agent_id ?? null, agentType: event.agent_type ?? null },
      };
    case 'PreCompact':
    case 'PostCompact':
      return {
        summary: clip(event.trigger ? `Compact (${event.trigger})` : 'Compact'),
        data: { trigger: event.trigger ?? null },
      };
  }
}

export interface NormalizeOptions {
  /** Defaults to `Date.now()`. */
  now?: number;
  /** Defaults to a generated id. */
  id?: string;
}

let counter = 0;
function nextId(now: number): string {
  counter = (counter + 1) % 1_679_616;
  return `hk-${now.toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turn a raw hook payload into an `ActivityEvent`. Never throws: payloads that are not
 * a recognised event (or are not even objects) become the `unknown` kind.
 */
export function normalizeHookEvent(
  raw: unknown,
  claudePid?: number | null,
  options: NormalizeOptions = {},
): ActivityEvent {
  const parsedNow = Timestamp.safeParse(options.now);
  const ts = parsedNow.success ? parsedNow.data : Date.now();
  const id = options.id ?? nextId(ts);
  const pid = Pid.safeParse(claudePid);

  const common = HookCommon.safeParse(raw);
  const base = {
    id,
    ts,
    projectId: null,
    terminalId: null,
    execId: null,
  };
  if (!common.success) {
    return {
      ...base,
      kind: 'unknown',
      sessionId: null,
      summary: null,
      data: { claudePid: pid.success ? pid.data : null },
    };
  }

  const meta = {
    hookEvent: common.data.hook_event_name,
    cwd: common.data.cwd ?? null,
    transcriptPath: common.data.transcript_path ?? null,
    permissionMode: common.data.permission_mode ?? null,
    claudePid: pid.success ? pid.data : null,
  };

  const known = KnownHookEvent.safeParse(raw);
  if (!known.success) {
    return {
      ...base,
      kind: 'unknown',
      sessionId: common.data.session_id,
      summary: clip(common.data.hook_event_name),
      data: meta,
    };
  }

  const { summary, data } = describeHook(known.data);
  return {
    ...base,
    kind: HOOK_KIND[known.data.hook_event_name],
    sessionId: known.data.session_id,
    summary,
    data: { ...meta, ...data },
  };
}

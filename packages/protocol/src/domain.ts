import { z } from 'zod';

/** Epoch milliseconds. */
export const Timestamp = z.number().int().nonnegative();
export const Pid = z.number().int().positive();
export const Id = z.string().min(1).max(256);

export const ProjectId = Id;
export const WindowId = Id;
export const TerminalId = Id;
export const ExecutionId = Id;
export const SessionId = Id;
export const ApprovalId = Id;
export const PortBindingId = Id;
export const ActivityEventId = Id;

export const ACCENT_COUNT = 10;
export const AccentIndex = z
  .number()
  .int()
  .min(0)
  .max(ACCENT_COUNT - 1);

export const GitFileStatus = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted',
]);
export type GitFileStatus = z.infer<typeof GitFileStatus>;

export const GitFileChange = z.object({
  /** Relative to the repository root. */
  path: z.string().min(1),
  /** Source path of a rename or copy. */
  origPath: z.string().nullable(),
  status: GitFileStatus,
  /** Has changes in the index. */
  staged: z.boolean(),
  /** Has changes in the working tree (always true for untracked and conflicted files). */
  unstaged: z.boolean(),
});
export type GitFileChange = z.infer<typeof GitFileChange>;

export const GitCommit = z.object({
  hash: z.string().min(1),
  author: z.string(),
  /** Author date. */
  at: Timestamp,
  subject: z.string(),
});
export type GitCommit = z.infer<typeof GitCommit>;

/** Files beyond this are counted in `dirty` but not listed. */
export const GIT_MAX_FILES = 200;
export const GIT_MAX_COMMITS = 5;

export const GitInfo = z.object({
  branch: z.string().nullable(),
  head: z.string().nullable(),
  detached: z.boolean(),
  /** Number of changed files, including any beyond the `files` cap. */
  dirty: z.number().int().nonnegative(),
  /** Upstream branch, e.g. `origin/main`. */
  upstream: z.string().nullable().default(null),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(GitFileChange).max(GIT_MAX_FILES).default([]),
  /** Newest first. */
  commits: z.array(GitCommit).max(GIT_MAX_COMMITS).default([]),
  updatedAt: Timestamp,
});
export type GitInfo = z.infer<typeof GitInfo>;

export const ProjectSource = z.enum(['editor', 'hook', 'manual']);
export type ProjectSource = z.infer<typeof ProjectSource>;

export const Project = z.object({
  id: ProjectId,
  /** Realpath of the project folder. */
  path: z.string().min(1),
  name: z.string().min(1),
  accent: AccentIndex,
  source: ProjectSource,
  git: GitInfo.nullable(),
  createdAt: Timestamp,
  lastActivityAt: Timestamp.nullable(),
});
export type Project = z.infer<typeof Project>;

/** The editor a CLI launch opens ("Opening in Cursor…"). */
export const EditorApp = z.enum(['Cursor', 'VS Code']);
export type EditorApp = z.infer<typeof EditorApp>;

export const EditorCapabilities = z.object({
  /** The editor has the shell-integration execution API; without it only the inventory is mirrored. */
  shellExecution: z.boolean(),
});
export type EditorCapabilities = z.infer<typeof EditorCapabilities>;

export const EditorWindow = z.object({
  id: WindowId,
  appName: z.string(),
  appVersion: z.string(),
  extensionVersion: z.string(),
  workspaceFolders: z.array(z.string()),
  projectIds: z.array(ProjectId),
  capabilities: EditorCapabilities,
  connectedAt: Timestamp,
  lastSeenAt: Timestamp,
});
export type EditorWindow = z.infer<typeof EditorWindow>;

export const ProcessStats = z.object({
  /** Root pid of the measured subtree. */
  pid: Pid,
  /** Summed CPU percent across the subtree (may exceed 100 on multi-core). */
  cpu: z.number().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
  sampledAt: Timestamp,
});
export type ProcessStats = z.infer<typeof ProcessStats>;

export const TerminalState = z.enum(['open', 'closed']);
export type TerminalState = z.infer<typeof TerminalState>;

export const Terminal = z.object({
  id: TerminalId,
  windowId: WindowId,
  projectId: ProjectId.nullable(),
  name: z.string(),
  shellPid: Pid.nullable(),
  cwd: z.string().nullable(),
  state: TerminalState,
  shellIntegration: z.boolean(),
  active: z.boolean(),
  exitCode: z.number().int().nullable(),
  executionIds: z.array(ExecutionId),
  stats: ProcessStats.nullable(),
  createdAt: Timestamp,
  closedAt: Timestamp.nullable(),
});
export type Terminal = z.infer<typeof Terminal>;

export const CommandConfidence = z.enum(['low', 'medium', 'high']);
export type CommandConfidence = z.infer<typeof CommandConfidence>;

export const Execution = z.object({
  id: ExecutionId,
  terminalId: TerminalId,
  commandLine: z.string(),
  confidence: CommandConfidence,
  cwd: z.string().nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  exitCode: z.number().int().nullable(),
  outputBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** The command switched to the alternate screen (a TUI such as htop or claude). */
  interactive: z.boolean(),
});
export type Execution = z.infer<typeof Execution>;

export const ToolFamily = z.enum([
  'bash',
  'edit',
  'read',
  'search',
  'web',
  'task',
  'todo',
  'other',
]);
export type ToolFamily = z.infer<typeof ToolFamily>;

export const ToolActivity = z.object({
  /** `tool_use_id` when known, otherwise a generated id. */
  id: Id,
  sessionId: SessionId,
  tool: z.string().min(1),
  family: ToolFamily,
  /** Short human caption, e.g. `src/cart.ts` or `pnpm test`. */
  summary: z.string().nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  status: z.enum(['running', 'ok', 'error']),
});
export type ToolActivity = z.infer<typeof ToolActivity>;

// Session status, PRD §4.2. Compacting remembers the state to return to on PostCompact.
const IdleStatus = z.object({ kind: z.literal('idle') });
const WorkingStatus = z.object({ kind: z.literal('working') });
const ToolStatus = z.object({
  kind: z.literal('tool'),
  tool: z.string().min(1),
  toolUseId: z.string().nullable(),
});
const WaitingPermissionStatus = z.object({
  kind: z.literal('waiting_permission'),
  approvalId: ApprovalId.nullable(),
});
const WaitingInputStatus = z.object({ kind: z.literal('waiting_input') });
const ErrorStatus = z.object({ kind: z.literal('error'), message: z.string().nullable() });
const EndedStatus = z.object({ kind: z.literal('ended') });
/** A board session whose query stopped with the server; `turnRunning`: mid-turn when it did. */
const InterruptedStatus = z.object({ kind: z.literal('interrupted'), turnRunning: z.boolean() });
/** No hook seen yet for a live process: "unknown, alive". */
const UnknownStatus = z.object({ kind: z.literal('unknown'), alive: z.boolean() });

export const ResumableSessionStatus = z.discriminatedUnion('kind', [
  IdleStatus,
  WorkingStatus,
  ToolStatus,
  WaitingPermissionStatus,
  WaitingInputStatus,
  ErrorStatus,
  UnknownStatus,
]);
export type ResumableSessionStatus = z.infer<typeof ResumableSessionStatus>;

const CompactingStatus = z.object({
  kind: z.literal('compacting'),
  previous: ResumableSessionStatus,
});

export const SessionStatus = z.discriminatedUnion('kind', [
  IdleStatus,
  WorkingStatus,
  ToolStatus,
  WaitingPermissionStatus,
  WaitingInputStatus,
  ErrorStatus,
  UnknownStatus,
  EndedStatus,
  InterruptedStatus,
  CompactingStatus,
]);
export type SessionStatus = z.infer<typeof SessionStatus>;
export type SessionStatusKind = SessionStatus['kind'];

export const SessionOrigin = z.enum(['terminal', 'board']);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const PermissionMode = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const TokenUsage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const TodoItem = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().nullable(),
});
export type TodoItem = z.infer<typeof TodoItem>;

export const Subagent = z.object({
  id: Id,
  type: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(['running', 'done', 'error']),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type Subagent = z.infer<typeof Subagent>;

export const BackgroundKind = z.enum(['shell', 'monitor', 'agent', 'other']);
export type BackgroundKind = z.infer<typeof BackgroundKind>;

export const BackgroundTaskStatus = z.enum(['running', 'done', 'error', 'stopped']);
export type BackgroundTaskStatus = z.infer<typeof BackgroundTaskStatus>;

export const BACKGROUND_LABEL_MAX = 120;
export const BACKGROUND_COMMAND_MAX = 2_000;
export const BACKGROUND_TAIL_MAX = 2_000;
export const MAX_BACKGROUND_TASKS = 20;

/** Work a session left running in the background: a shell, a Monitor watch, an async subagent. */
export const BackgroundTask = z.object({
  /** Claude Code's task id (`backgroundTaskId`, Monitor's `taskId`, an agent id), else the tool call's id. */
  id: Id,
  kind: BackgroundKind,
  /** One line: the tool's `description`, else the command. */
  label: z.string().max(BACKGROUND_LABEL_MAX),
  /** The command as typed, for shells and monitors. Lives only as long as the session. */
  command: z.string().max(BACKGROUND_COMMAND_MAX).nullable().optional(),
  /** The tool call that started it. */
  toolUseId: z.string().max(256).nullable().optional(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  status: BackgroundTaskStatus,
  exitCode: z.number().int().nullable(),
  /** The process running it, once found under the session's Claude process. */
  pid: Pid.nullable(),
  /** The end of its output, or its completion summary, when the transcript has it. */
  tail: z.string().max(BACKGROUND_TAIL_MAX).nullable().optional(),
});
export type BackgroundTask = z.infer<typeof BackgroundTask>;

export const ClaudeSession = z.object({
  id: SessionId,
  origin: SessionOrigin,
  projectId: ProjectId.nullable(),
  cwd: z.string().nullable(),
  status: SessionStatus,
  /** An automatic name (Claude Code's `<folder>-<code>`, or the first prompt); a subtitle only. */
  title: z.string().nullable(),
  /** A name the user gave the session (`/rename`), shown as its name. */
  customTitle: z.string().max(512).nullable().optional(),
  /** "Claude 2": the session's number among its project's unnamed live sessions, kept for life. */
  ordinal: z.number().int().positive().nullable().optional(),
  /** A fork: the session it branched off, and when; earlier messages are the parent's. */
  forkedFrom: z.object({ sessionId: SessionId, at: Timestamp }).nullable().optional(),
  model: z.string().nullable(),
  permissionMode: PermissionMode.nullable(),
  tokens: TokenUsage,
  contextTokens: z.number().int().nonnegative().nullable(),
  currentTool: ToolActivity.nullable(),
  todos: z.array(TodoItem),
  subagents: z.array(Subagent),
  /** Background shells, monitors and async subagents, newest last. Not persisted. */
  background: z.array(BackgroundTask).max(MAX_BACKGROUND_TASKS).optional(),
  terminalId: TerminalId.nullable(),
  claudePid: Pid.nullable(),
  transcriptPath: z.string().nullable(),
  lastAssistantText: z.string().nullable(),
  /** When `lastAssistantText` was set, so a client can tell it from a newer turn's prompt. */
  lastAssistantAt: Timestamp.nullable().optional(),
  /** Board sessions: the assistant text still streaming in, until its message lands. */
  draft: z.string().max(100_000).nullable().optional(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type ClaudeSession = z.infer<typeof ClaudeSession>;

/** Why a session can't take a reply in its terminal, or null when it can (F14). */
export type TerminalReplyBlock = 'not_terminal_session' | 'no_linked_terminal' | 'session_busy';

/** Only a terminal session at its prompt (idle, or waiting for input) gets typed into. */
export function terminalReplyBlock(
  session: Pick<ClaudeSession, 'origin' | 'terminalId' | 'status'>,
): TerminalReplyBlock | null {
  if (session.origin !== 'terminal') return 'not_terminal_session';
  if (session.terminalId === null) return 'no_linked_terminal';
  const { kind } = session.status;
  return kind === 'idle' || kind === 'waiting_input' ? null : 'session_busy';
}

export const ApprovalSource = z.enum(['sdk', 'hook']);
export type ApprovalSource = z.infer<typeof ApprovalSource>;

export const ApprovalState = z.enum(['pending', 'allowed', 'denied', 'expired']);
export type ApprovalState = z.infer<typeof ApprovalState>;

/** An SDK `PermissionUpdate` offered for "Always allow"; kept opaque beyond its type. */
export const PermissionSuggestion = z.looseObject({ type: z.string().min(1).max(64) });
export type PermissionSuggestion = z.infer<typeof PermissionSuggestion>;

export const Approval = z.object({
  id: ApprovalId,
  sessionId: SessionId,
  source: ApprovalSource,
  tool: z.string().min(1),
  input: z.unknown(),
  toolUseId: z.string().nullable(),
  /** SDK approvals: what "Always allow" would add. Empty or absent: allow once only. */
  suggestions: z.array(PermissionSuggestion).max(64).optional(),
  /** The path outside the allowed directories that triggered the request, if any. */
  blockedPath: z.string().max(4_096).nullable().optional(),
  createdAt: Timestamp,
  expiresAt: Timestamp.nullable(),
  state: ApprovalState,
  decidedAt: Timestamp.nullable(),
  reason: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const ActivityKind = z.enum([
  'session.start',
  'session.end',
  'prompt',
  'tool.start',
  'tool.end',
  'tool.error',
  'notification',
  'permission.request',
  'permission.decision',
  'stop',
  'stop.failure',
  'subagent.start',
  'subagent.stop',
  'background.start',
  'background.end',
  'compact.start',
  'compact.end',
  'exec.start',
  'exec.end',
  'unknown',
]);
export type ActivityKind = z.infer<typeof ActivityKind>;

export const ActivityEvent = z.object({
  id: ActivityEventId,
  ts: Timestamp,
  kind: ActivityKind,
  projectId: ProjectId.nullable(),
  sessionId: SessionId.nullable(),
  terminalId: TerminalId.nullable(),
  execId: ExecutionId.nullable(),
  /** Short caption for the Pulse tooltip. */
  summary: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const PortBinding = z.object({
  /** `<address>:<port>`. */
  id: PortBindingId,
  port: z.number().int().min(1).max(65535),
  address: z.string(),
  pid: Pid,
  command: z.string().nullable(),
  terminalId: TerminalId.nullable(),
  projectId: ProjectId.nullable(),
  firstSeenAt: Timestamp,
});
export type PortBinding = z.infer<typeof PortBinding>;

function keyedBy<T extends z.ZodType<{ id: string }>>(item: T) {
  return z.record(z.string(), item).superRefine((map, ctx) => {
    for (const [key, value] of Object.entries(map)) {
      if (value.id !== key) {
        ctx.addIssue({ code: 'custom', message: `key "${key}" does not match id`, path: [key] });
      }
    }
  });
}

/** The whole board, normalized into maps keyed by id. */
export const BoardState = z.object({
  projects: keyedBy(Project),
  windows: keyedBy(EditorWindow),
  terminals: keyedBy(Terminal),
  executions: keyedBy(Execution),
  sessions: keyedBy(ClaudeSession),
  approvals: keyedBy(Approval),
  ports: keyedBy(PortBinding),
});
export type BoardState = z.infer<typeof BoardState>;

export function emptyBoardState(): BoardState {
  return {
    projects: {},
    windows: {},
    terminals: {},
    executions: {},
    sessions: {},
    approvals: {},
    ports: {},
  };
}

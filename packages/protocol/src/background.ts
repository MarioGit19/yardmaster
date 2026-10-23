import {
  BACKGROUND_COMMAND_MAX,
  BACKGROUND_LABEL_MAX,
  BACKGROUND_TAIL_MAX,
  type BackgroundKind,
  type BackgroundTask,
  type BackgroundTaskStatus,
  MAX_BACKGROUND_TASKS,
} from './domain.js';

// Background work of a Claude session (shells, Monitor watches, async subagents). Field names
// follow the Agent SDK's tool types (`BashOutput.backgroundTaskId`, `MonitorOutput.taskId`, the
// Agent tool's `{ status: 'async_launched', agentId }`) and its `task_*` system messages. Every
// reader here is lenient: unknown shapes yield null rather than throwing.

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * The kind of background work a tool call starts, or null for a foreground call. With the
 * response, a shell the timeout moved to the background and a subagent Claude Code
 * backgrounded on its own count too.
 */
export function backgroundLaunchKind(
  tool: string,
  input: unknown,
  response?: unknown,
): BackgroundKind | null {
  const args = obj(input);
  const result = obj(response);
  if (tool === 'Monitor') return 'monitor';
  if (SHELL_TOOLS.has(tool)) {
    if (args?.run_in_background === true) return 'shell';
    return str(result?.backgroundTaskId) ? 'shell' : null;
  }
  if (AGENT_TOOLS.has(tool)) {
    if (args?.run_in_background === true) return 'agent';
    return result?.status === 'async_launched' ? 'agent' : null;
  }
  return null;
}

/** The task id a background launch reported in its tool response, if any. */
export function backgroundTaskIdOf(response: unknown): string | null {
  const result = obj(response);
  if (!result) return null;
  const id = str(result.backgroundTaskId) ?? str(result.taskId) ?? str(result.agentId);
  return id === null ? null : id.slice(0, 256);
}

/** One line for a background task: the tool's `description`, else the command (or socket). */
export function backgroundLabel(input: unknown): string {
  const args = obj(input);
  const text =
    str(args?.description) ??
    str(args?.command) ??
    str(obj(args?.ws)?.url) ??
    str(args?.prompt) ??
    'Background task';
  return oneLine(text, BACKGROUND_LABEL_MAX);
}

export function backgroundCommand(input: unknown): string | null {
  const command = str(obj(input)?.command);
  return command === null ? null : command.slice(0, BACKGROUND_COMMAND_MAX);
}

/** Claude Code's task types (`local_bash`, `local_agent`, `monitor`, `shell`, …) as a kind. */
export function backgroundKindOf(type: unknown): BackgroundKind {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  if (t.includes('bash') || t.includes('shell') || t.includes('powershell')) return 'shell';
  if (t.includes('monitor')) return 'monitor';
  if (t.includes('agent')) return 'agent';
  return 'other';
}

/** Ids of the same agent compare equal whether or not they carry Claude Code's `agent-` prefix. */
export function sameTaskId(a: string, b: string): boolean {
  return a === b || a.replace(/^agent-/, '') === b.replace(/^agent-/, '');
}

export interface BackgroundStart {
  id: string;
  kind: BackgroundKind;
  label: string;
  command?: string | null;
  toolUseId?: string | null;
  ts: number;
  status?: BackgroundTaskStatus;
}

/** Adds a running task, or does nothing when one with that id is already listed. */
export function startBackground(
  list: readonly BackgroundTask[],
  start: BackgroundStart,
): BackgroundTask[] {
  if (list.some((task) => sameTaskId(task.id, start.id))) return [...list];
  const status = start.status ?? 'running';
  const task: BackgroundTask = {
    id: start.id,
    kind: start.kind,
    label: start.label,
    command: start.command ?? null,
    toolUseId: start.toolUseId ?? null,
    startedAt: start.ts,
    endedAt: status === 'running' ? null : start.ts,
    status,
    exitCode: null,
    pid: null,
    tail: null,
  };
  // Over the cap, the oldest finished task goes first, then the oldest of all.
  const next = [...list, task];
  while (next.length > MAX_BACKGROUND_TASKS) {
    const finished = next.findIndex((t) => t.status !== 'running');
    next.splice(finished === -1 ? 0 : finished, 1);
  }
  return next;
}

export interface BackgroundEnd {
  status: Exclude<BackgroundTaskStatus, 'running'>;
  ts: number;
  exitCode?: number | null;
  tail?: string | null;
}

/**
 * Ends a running task. A task that already ended without an exit code may still gain one (and
 * turn into an error) from a later, more detailed report; anything else stays as it is.
 */
export function endBackground(task: BackgroundTask, end: BackgroundEnd): BackgroundTask {
  const tail = end.tail ? end.tail.slice(-BACKGROUND_TAIL_MAX) : (task.tail ?? null);
  if (task.status === 'running') {
    return {
      ...task,
      status: end.status,
      endedAt: Math.max(task.startedAt, end.ts),
      exitCode: end.exitCode ?? task.exitCode,
      tail,
    };
  }
  if (task.status === 'done' && task.exitCode === null && end.exitCode != null) {
    return {
      ...task,
      exitCode: end.exitCode,
      status: end.exitCode === 0 ? 'done' : 'error',
      tail,
    };
  }
  return task;
}

/** Every running task becomes `stopped`: its session ended. Returns the list itself if none ran. */
export function stopAllBackground(
  list: readonly BackgroundTask[],
  ts: number,
): readonly BackgroundTask[] {
  if (!list.some((task) => task.status === 'running')) return list;
  return list.map((task) =>
    task.status === 'running' ? endBackground(task, { status: 'stopped', ts }) : task,
  );
}

/** One entry of a `Stop` hook's `background_tasks`, or of the SDK's `background_tasks_changed`. */
export interface LiveTaskEntry {
  id: string;
  kind: BackgroundKind;
  label: string;
  command: string | null;
  /** Housekeeping watchers: not activity, so they are left off the board. */
  ambient: boolean;
}

/** Reads a live-task list leniently: entries without an id are skipped. */
export function parseLiveTasks(raw: unknown): LiveTaskEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const tasks: LiveTaskEntry[] = [];
  for (const item of raw.slice(0, 200)) {
    const entry = obj(item);
    const id = str(entry?.id) ?? str(entry?.task_id);
    if (!entry || id === null) continue;
    const status = str(entry.status);
    if (status !== null && status !== 'running' && status !== 'pending') continue;
    const command = str(entry.command);
    tasks.push({
      id: id.slice(0, 256),
      kind: backgroundKindOf(entry.type ?? entry.task_type),
      label: oneLine(
        str(entry.description) ?? command ?? str(entry.tool) ?? 'Background task',
        BACKGROUND_LABEL_MAX,
      ),
      command: command === null ? null : command.slice(0, BACKGROUND_COMMAND_MAX),
      ambient: entry.ambient === true,
    });
  }
  return tasks;
}

/**
 * Brings the list in line with a full snapshot of the live tasks (REPLACE semantics, as the SDK
 * documents for `background_tasks_changed`): listed tasks run, running tasks not listed are done.
 * A task keyed by its tool call's id (no task id in the response) takes over a listed task of
 * its kind and label instead of leaving a duplicate.
 */
export function reconcileBackground(
  list: readonly BackgroundTask[],
  live: readonly LiveTaskEntry[],
  ts: number,
): BackgroundTask[] {
  let next = [...list];
  for (const entry of live) {
    if (entry.ambient || next.some((task) => sameTaskId(task.id, entry.id))) continue;
    const provisional = next.findIndex(
      (task) =>
        task.status === 'running' &&
        task.id === task.toolUseId &&
        task.kind === entry.kind &&
        (task.label === entry.label || (entry.command !== null && task.command === entry.command)),
    );
    if (provisional !== -1) {
      next[provisional] = { ...(next[provisional] as BackgroundTask), id: entry.id };
      continue;
    }
    next = startBackground(next, {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      command: entry.command,
      ts,
    });
  }
  return next.map((task) =>
    task.status === 'running' && !live.some((entry) => sameTaskId(entry.id, task.id))
      ? endBackground(task, { status: 'done', ts })
      : task,
  );
}

export interface TaskNotification {
  id: string;
  status: Exclude<BackgroundTaskStatus, 'running'>;
  exitCode: number | null;
  summary: string | null;
}

/** Claude Code's notification statuses (`completed`, `failed`, `killed`, …) as a task status. */
export function notificationStatus(
  status: string | null,
  exitCode: number | null,
): TaskNotification['status'] {
  const s = status?.toLowerCase() ?? '';
  if (s.includes('fail') || s.includes('error') || (exitCode !== null && exitCode !== 0)) {
    return 'error';
  }
  if (s.includes('kill') || s.includes('stop') || s.includes('cancel') || s.includes('timeout')) {
    return 'stopped';
  }
  return 'done';
}

const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
const EXIT_CODE = /exit code:?\s*(-?\d+)/i;

/** The exit code a completion summary mentions (`… completed (exit code 1)`), or null. */
export function exitCodeOf(summary: string | null | undefined): number | null {
  const code = summary ? EXIT_CODE.exec(summary)?.[1] : undefined;
  return code === undefined ? null : Number(code);
}

/**
 * The `<task-notification>` blocks Claude Code adds to the conversation when a background task
 * finishes (`<task-id>`, `<status>`, `<summary>`, an optional `<exit-code>`).
 */
export function parseTaskNotifications(text: string): TaskNotification[] {
  if (!text.includes('<task-notification>')) return [];
  const found: TaskNotification[] = [];
  for (const block of text.split('<task-notification>').slice(1, 21)) {
    const body = block.split('</task-notification>')[0] ?? '';
    const id = TAG('task-id').exec(body)?.[1]?.trim();
    if (!id) continue;
    const summary = TAG('summary').exec(body)?.[1]?.trim() || null;
    const tagged = TAG('exit-code').exec(body)?.[1]?.trim();
    const exitCode = tagged && /^-?\d+$/.test(tagged) ? Number(tagged) : exitCodeOf(summary);
    const status = TAG('status').exec(body)?.[1]?.trim() ?? null;
    found.push({
      id: id.slice(0, 256),
      status: notificationStatus(status, exitCode),
      exitCode,
      summary: summary === null ? null : summary.slice(0, BACKGROUND_TAIL_MAX),
    });
  }
  return found;
}

/** Applies finished-task reports to the list; tasks it doesn't know are ignored. */
export function applyTaskNotifications(
  list: readonly BackgroundTask[],
  notes: readonly TaskNotification[],
  ts: number,
): readonly BackgroundTask[] {
  let next = list;
  for (const note of notes) {
    const index = next.findIndex((task) => sameTaskId(task.id, note.id));
    if (index === -1) continue;
    const task = next[index] as BackgroundTask;
    const ended = endBackground(task, {
      status: note.status,
      ts,
      exitCode: note.exitCode,
      tail: note.summary,
    });
    if (ended !== task) next = next.map((t, i) => (i === index ? ended : t));
  }
  return next;
}

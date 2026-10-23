import {
  type BackgroundKind,
  type BackgroundTaskStatus,
  type ClaudeSession,
  sameTaskId,
} from '@c-board/protocol';

/** Finished work stays listed this long, then folds into "3 finished". */
export const FINISHED_VISIBLE_MS = 120_000;
/** Labels named in a session row's background line; the rest are counted. */
const LINE_LABELS = 2;

/** One thing a session has going on beside its turn: a background task or a subagent. */
export interface BackgroundItem {
  id: string;
  kind: BackgroundKind;
  label: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  tail: string | null;
}

type Source = Pick<ClaudeSession, 'background' | 'subagents'>;

const subagentLabel = (type: string | null, description: string | null) =>
  type && description ? `${type}: ${description}` : (description ?? type ?? 'Subagent');

/**
 * The session's background tasks and subagents as one list, oldest first. A subagent launched
 * in the background is both; it is listed once, as the agent task, named after its type.
 */
export function backgroundItems(session: Source): BackgroundItem[] {
  const tasks = session.background ?? [];
  const items: BackgroundItem[] = tasks.map((task) => {
    const agent =
      task.kind === 'agent' ? session.subagents.find((a) => sameTaskId(a.id, task.id)) : undefined;
    return {
      id: task.id,
      kind: task.kind,
      label: agent ? subagentLabel(agent.type, task.label) : task.label,
      status: task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      exitCode: task.exitCode,
      tail: task.tail ?? null,
    };
  });
  for (const agent of session.subagents) {
    if (tasks.some((task) => sameTaskId(task.id, agent.id))) continue;
    items.push({
      id: agent.id,
      kind: 'agent',
      label: subagentLabel(agent.type, agent.description),
      status: agent.status,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      exitCode: null,
      tail: null,
    });
  }
  return items.sort((a, b) => a.startedAt - b.startedAt);
}

/** How many tasks and subagents are running: what counts as "in the background". */
export function runningBackground(session: Source): number {
  let count = 0;
  for (const task of session.background ?? []) if (task.status === 'running') count++;
  for (const agent of session.subagents) {
    if (agent.status !== 'running') continue;
    if (!(session.background ?? []).some((task) => sameTaskId(task.id, agent.id))) count++;
  }
  return count;
}

/** Running shells, monitors and other tasks: the crew's helpers (subagents are its mini crew). */
export function runningHelpers(session: Pick<ClaudeSession, 'background'>): BackgroundKind[] {
  return (session.background ?? [])
    .filter((task) => task.status === 'running' && task.kind !== 'agent')
    .map((task) => task.kind);
}

export interface BackgroundGroups {
  running: BackgroundItem[];
  /** Finished in the last two minutes, newest first. */
  recent: BackgroundItem[];
  /** Finished before that. */
  folded: number;
}

export function groupBackground(items: readonly BackgroundItem[], now: number): BackgroundGroups {
  const running: BackgroundItem[] = [];
  const recent: BackgroundItem[] = [];
  let folded = 0;
  for (const item of items) {
    if (item.status === 'running') running.push(item);
    else if (now - (item.endedAt ?? item.startedAt) < FINISHED_VISIBLE_MS) recent.push(item);
    else folded++;
  }
  recent.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  return { running, recent, folded };
}

/** A row's one-line summary of what runs: `2 running: Typecheck watcher · Explore: …`, or null. */
export function backgroundLine(items: readonly BackgroundItem[]): string | null {
  const running = items.filter((item) => item.status === 'running');
  if (running.length === 0) return null;
  const named = running.slice(-LINE_LABELS).map((item) => item.label);
  return `${running.length} running: ${named.join(' · ')}`;
}

/** `0:42`, `12:05`, `1:02:09`: elapsed time that ticks without changing width much. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const KIND_LABEL: Record<BackgroundKind, string> = {
  shell: 'Shell',
  monitor: 'Monitor',
  agent: 'Subagent',
  other: 'Task',
};

/** What a finished item's status reads as: `Done`, `Exit 1`, `Failed`, `Stopped`. */
export function endedLabel(item: Pick<BackgroundItem, 'status' | 'exitCode'>): string {
  if (item.status === 'error') return item.exitCode !== null ? `Exit ${item.exitCode}` : 'Failed';
  if (item.status === 'stopped') return 'Stopped';
  return 'Done';
}

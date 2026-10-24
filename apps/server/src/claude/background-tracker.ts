import {
  type ActivityEvent,
  type BackgroundKind,
  type BackgroundTask,
  type BackgroundTaskStatus,
  type ClaudeSession,
  endBackground,
  stopAllBackground,
} from '@yardmaster/protocol';
import type { ProcessTree } from '../processes.js';
import type { BoardStore } from '../store.js';

export interface BackgroundTrackerOptions {
  store: BoardStore;
  onActivity?: (event: ActivityEvent) => void;
  now?: () => number;
}

const NOUN: Record<BackgroundKind, string> = {
  shell: 'Background shell',
  monitor: 'Monitor',
  agent: 'Background agent',
  other: 'Background task',
};

const VERB: Record<BackgroundTaskStatus, string> = {
  running: 'started',
  done: 'finished',
  error: 'failed',
  stopped: 'stopped',
};

/** Shells and monitors run a process of their own under Claude's; agents run inside it. */
const HAS_PROCESS = new Set<BackgroundKind>(['shell', 'monitor']);
/** Enough of a command to recognise it in `ps`, past the shell's own quoting. */
const NEEDLE_CHARS = 48;

let counter = 0;

/**
 * Keeps sessions' background tasks honest across every way a session changes: a session that
 * ends stops its tasks, a shell ends when its process does (matched under the session's Claude
 * process in each `ps` sample), and starts and ends go to the Pulse as activity. The activity
 * carries the task's kind and status only; labels and commands never reach the database.
 */
export class BackgroundTracker {
  private readonly store: BoardStore;
  private readonly onActivity: (event: ActivityEvent) => void;
  private readonly now: () => number;
  /** Last seen status of each task, per session. */
  private readonly seen = new Map<string, Map<string, BackgroundTaskStatus>>();
  private readonly detach: () => void;

  constructor(options: BackgroundTrackerOptions) {
    this.store = options.store;
    this.onActivity = options.onActivity ?? (() => {});
    this.now = options.now ?? Date.now;
    for (const session of Object.values(this.store.state.sessions)) this.remember(session);
    this.detach = this.store.onPatch((ops) => {
      const ids = new Set<string>();
      let all = false;
      for (const op of ops) {
        if (op.path[0] !== 'sessions') continue;
        if (op.path[1] === undefined) all = true;
        else ids.add(op.path[1]);
      }
      if (all)
        for (const id of [...this.seen.keys(), ...Object.keys(this.store.state.sessions)])
          ids.add(id);
      for (const id of ids) this.check(id);
    });
  }

  stop(): void {
    this.detach();
  }

  /** Matches running shells to processes and ends those whose process has exited. */
  sample(tree: ProcessTree): void {
    for (const session of Object.values(this.store.state.sessions)) {
      const background = session.background;
      if (!background || session.claudePid === null || isOver(session)) continue;
      if (!background.some((t) => t.status === 'running' && HAS_PROCESS.has(t.kind))) continue;
      if (!tree.procs.has(session.claudePid)) continue;
      const next = this.applyTree(background, session.claudePid, tree);
      if (next !== background) {
        this.store.updateSession(session.id, {
          background: [...next],
          updatedAt: session.updatedAt,
        });
      }
    }
  }

  private applyTree(
    background: readonly BackgroundTask[],
    claudePid: number,
    tree: ProcessTree,
  ): readonly BackgroundTask[] {
    const claimed = new Set(background.flatMap((t) => (t.pid === null ? [] : [t.pid])));
    const ts = this.now();
    let changed = false;
    const next = background.map((task) => {
      if (task.status !== 'running' || !HAS_PROCESS.has(task.kind)) return task;
      if (task.pid !== null) {
        if (tree.procs.has(task.pid)) return task;
        changed = true;
        return endBackground(task, { status: 'done', ts });
      }
      const pid = findProcess(tree, claudePid, task.command ?? null, claimed);
      if (pid === null) return task;
      claimed.add(pid);
      changed = true;
      return { ...task, pid };
    });
    return changed ? next : background;
  }

  private check(id: string): void {
    const session = this.store.state.sessions[id];
    if (!session) {
      this.seen.delete(id);
      return;
    }
    const background = session.background;
    if (background && isOver(session)) {
      const stopped = stopAllBackground(background, session.endedAt ?? this.now());
      if (stopped !== background) {
        // The next patch reports the stopped tasks.
        this.store.updateSession(id, { background: [...stopped], updatedAt: session.updatedAt });
        return;
      }
    }
    this.report(session);
  }

  private report(session: ClaudeSession): void {
    const before = this.seen.get(session.id);
    for (const task of session.background ?? []) {
      const was = before?.get(task.id);
      if (was === task.status) continue;
      if (was === undefined && task.status !== 'running') {
        // Never seen running (a launch that failed): one event for its end.
        this.emit(session, task, task.status);
      } else if (was === undefined) {
        this.emit(session, task, 'running');
      } else if (was === 'running') {
        this.emit(session, task, task.status);
      }
    }
    this.remember(session);
  }

  private remember(session: ClaudeSession): void {
    const background = session.background ?? [];
    if (background.length === 0) {
      this.seen.delete(session.id);
      return;
    }
    this.seen.set(session.id, new Map(background.map((t) => [t.id, t.status])));
  }

  private emit(session: ClaudeSession, task: BackgroundTask, status: BackgroundTaskStatus): void {
    const ts = status === 'running' ? task.startedAt : (task.endedAt ?? this.now());
    counter = (counter + 1) % 1_679_616;
    this.onActivity({
      id: `bg-${ts.toString(36)}-${counter.toString(36)}`,
      ts,
      kind: status === 'running' ? 'background.start' : 'background.end',
      projectId: session.projectId,
      sessionId: session.id,
      terminalId: session.terminalId,
      execId: null,
      summary: `${NOUN[task.kind]} ${VERB[status]}`,
      data: { taskId: task.id, taskKind: task.kind, status, exitCode: task.exitCode },
    });
  }
}

function isOver(session: ClaudeSession): boolean {
  return session.status.kind === 'ended' || session.status.kind === 'interrupted';
}

function squash(text: string): string {
  return text
    .replace(/["'\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The topmost process under `root` whose command line contains the start of `command`,
 * skipping pids already matched to another task.
 */
export function findProcess(
  tree: ProcessTree,
  root: number,
  command: string | null,
  claimed: ReadonlySet<number> = new Set(),
): number | null {
  if (command === null) return null;
  const needle = squash(command).slice(0, NEEDLE_CHARS);
  if (needle.length < 2) return null;
  const queue = [...(tree.children.get(root) ?? [])];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = tree.procs.get(pid);
    if (proc && !claimed.has(pid) && squash(proc.command).includes(needle)) return pid;
    queue.push(...(tree.children.get(pid) ?? []));
  }
  return null;
}

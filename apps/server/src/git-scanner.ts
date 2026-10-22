import { execFile } from 'node:child_process';
import { GitInfo } from '@c-board/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { GIT_LOG_ARGS, GIT_STATUS_ARGS, parseGitLog, parseGitStatus, sameGitInfo } from './git.js';
import type { BoardStore } from './store.js';

export const GIT_INTERVAL_MS = 5_000;
/** How long a folder that isn't a repository is left alone before it's checked again. */
export const NOT_REPO_RECHECK_MS = 60_000;
/** Coalesces bursts of hook-triggered refreshes. */
export const GIT_REFRESH_DEBOUNCE_MS = 250;
const COMMAND_TIMEOUT_MS = 4_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

/** Runs `git` on the repository at `dir` with an argument array and resolves its stdout. */
export type GitRunner = (dir: string, args: readonly string[]) => Promise<string>;

export interface GitScannerOptions {
  store: BoardStore;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  /** Polling only runs while this is true (connected UI clients). */
  active: () => boolean;
  run?: GitRunner;
  intervalMs?: number;
  debounceMs?: number;
  now?: () => number;
}

/**
 * Fills each project's `GitInfo` (PRD F15) from `git status` and `git log`: every few
 * seconds while someone is watching, and soon after Claude edits files or runs a command.
 */
export class GitScanner {
  private readonly store: BoardStore;
  private readonly log: GitScannerOptions['logger'];
  private readonly active: () => boolean;
  private readonly run: GitRunner;
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private readonly busy = new Set<string>();
  private readonly again = new Set<string>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly notRepoUntil = new Map<string, number>();
  private readonly warned = new Set<string>();
  private unavailable = false;
  private stopped = false;

  constructor(options: GitScannerOptions) {
    this.store = options.store;
    this.log = options.logger;
    this.active = options.active;
    this.run = options.run ?? runGit;
    this.intervalMs = options.intervalMs ?? GIT_INTERVAL_MS;
    this.debounceMs = options.debounceMs ?? GIT_REFRESH_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** Stops polling; results of a scan still in flight are dropped. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** Scans every project, if a UI client is connected. Never throws. */
  async tick(): Promise<void> {
    if (!this.active()) return;
    for (const id of Object.keys(this.store.state.projects)) {
      if (this.stopped) return;
      await this.scan(id);
    }
  }

  /** Schedules a scan of one project soon, e.g. after a hook reports an edit. */
  request(projectId: string): void {
    if (this.stopped || this.pending.has(projectId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(projectId);
      void this.scan(projectId);
    }, this.debounceMs);
    timer.unref();
    this.pending.set(projectId, timer);
  }

  /** Reads one project's repository and writes its `git` if it changed. Never throws. */
  async scan(projectId: string): Promise<void> {
    if (this.unavailable || this.stopped) return;
    if (this.busy.has(projectId)) {
      this.again.add(projectId);
      return;
    }
    const project = this.store.state.projects[projectId];
    if (!project) return;
    if ((this.notRepoUntil.get(projectId) ?? 0) > this.now()) return;
    this.busy.add(projectId);
    try {
      const next = await this.read(project.path);
      if (this.stopped || next === undefined) return;
      const current = this.store.state.projects[projectId];
      if (!current || current.path !== project.path) return;
      if (next === null) this.notRepoUntil.set(projectId, this.now() + NOT_REPO_RECHECK_MS);
      else this.notRepoUntil.delete(projectId);
      if (!sameGitInfo(current.git, next)) this.store.upsertProject({ ...current, git: next });
    } finally {
      this.busy.delete(projectId);
      if (this.again.delete(projectId)) void this.scan(projectId);
    }
  }

  /** The repository state, null for a folder outside git, undefined if git failed. */
  private async read(path: string): Promise<GitInfo | null | undefined> {
    let statusOut: string;
    try {
      statusOut = await this.run(path, GIT_STATUS_ARGS);
    } catch (err) {
      return this.failed(err, path);
    }
    const status = parseGitStatus(statusOut);
    let commits: GitInfo['commits'] = [];
    // A repository without commits has nothing to log (git exits 128).
    if (status.head !== null) {
      try {
        commits = parseGitLog(await this.run(path, GIT_LOG_ARGS));
      } catch (err) {
        return this.failed(err, path);
      }
    }
    const parsed = GitInfo.safeParse({ ...status, commits, updatedAt: this.now() });
    if (!parsed.success) {
      this.warnOnce(
        `invalid:${path}`,
        { issues: parsed.error.issues.length },
        'unexpected git output',
      );
      return undefined;
    }
    return parsed.data;
  }

  private failed(err: unknown, path: string): null | undefined {
    if (errorCode(err) === 'ENOENT') {
      this.unavailable = true;
      this.log.warn('git not found; git info is off');
      return undefined;
    }
    // Also covers a project folder that no longer exists.
    if (/not a git repository|cannot change to/i.test(errorStderr(err))) return null;
    this.warnOnce(path, { err }, 'git scan failed');
    return undefined;
  }

  private warnOnce(key: string, data: object, message: string): void {
    if (this.warned.has(key)) {
      this.log.debug(data, message);
      return;
    }
    this.warned.add(key);
    this.log.warn(data, message);
  }
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function errorStderr(err: unknown): string {
  const stderr =
    typeof err === 'object' && err !== null ? (err as { stderr?: unknown }).stderr : undefined;
  return typeof stderr === 'string' ? stderr : '';
}

/**
 * `execFile` without a shell. Optional locks are off so polling never blocks the user's
 * own git commands, and `core.fsmonitor` is off so a repository's config can't make
 * us run a program.
 */
export const runGit: GitRunner = (dir, args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'color.ui=false',
        '-C',
        dir,
        ...args,
      ],
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve(stdout);
      },
    );
  });

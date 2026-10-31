import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type GitFileChange,
  type GitFileStatus,
  type GitReview,
  type GitReviewFile,
  type GitWorktree,
  type PullRequestBadge,
  PullRequestResponse,
  REVIEW_ERRORS,
  REVIEW_MAX_FILE_PATCH,
  REVIEW_MAX_FILES,
  REVIEW_MAX_TOTAL_PATCH,
  type UiAction,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { ActionHandler, ActionHandlers, ActionResult } from './actions.js';
import { ROUTE_ERRORS } from './editor-router.js';
import {
  configRunsCommands,
  GIT_CONFIG_ARGS,
  GIT_STATUS_ARGS,
  GIT_WORKTREE_ARGS,
  parseGitStatus,
  parseGitWorktrees,
} from './git.js';
import { type GitRunner, gitEnv, gitRunner } from './git-scanner.js';
import type { BoardStore } from './store.js';

const READ_TIMEOUT_MS = 20_000;
const READ_MAX_OUTPUT = 64 * 1024 * 1024;
/** Commits run the user's hooks and signing, so they get time a read never needs. */
const WRITE_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 8_000;
const GH_CACHE_MS = 60_000;
const MAX_DETAIL = 400;

/** External diff drivers and textconv run programs, so a review turns both off. */
const DIFF_ARGS = [
  '-c',
  'core.quotePath=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-relative',
  '--ignore-submodules=all',
  '--find-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
] as const;

const REVIEW_STATUS_ARGS = [...GIT_STATUS_ARGS, '--untracked-files=all'] as const;

/** What a board review reads and does; the demo answers with its own synthetic one. */
export interface ReviewSource {
  read(projectId: string, worktree: string | null): Promise<ReviewOutcome>;
  pullRequest(projectId: string, worktree: string | null): Promise<PullRequestBadge | null>;
  commit(action: Extract<UiAction, { kind: 'git.commit' }>): Promise<ActionResult>;
  discard(action: Extract<UiAction, { kind: 'git.discard' }>): Promise<ActionResult>;
}

export type ReviewOutcome = { ok: true; review: GitReview } | { ok: false; error: string };

export interface NumstatEntry {
  path: string;
  origPath: string | null;
  added: number;
  removed: number;
  binary: boolean;
}

/** Parses `git diff --numstat -z`; a rename's paths are the two records after an empty field. */
export function parseNumstat(stdout: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const records = stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(records[i] ?? '');
    if (!match) continue;
    const [, added = '0', removed = '0', inline = ''] = match;
    const origPath = inline === '' ? (records[++i] ?? null) : null;
    const path = inline === '' ? records[++i] : inline;
    if (!path) continue;
    entries.push({
      path,
      origPath,
      added: added === '-' ? 0 : Number(added),
      removed: removed === '-' ? 0 : Number(removed),
      binary: added === '-',
    });
  }
  return entries;
}

/** Cuts a whole `git diff` into one section per file, in the order git printed them. */
export function splitPatch(patch: string): string[] {
  const starts: number[] = [];
  const header = /^(?:diff --git |diff --cc |diff --combined )/gm;
  for (const match of patch.matchAll(header)) starts.push(match.index);
  return starts.map((start, i) => patch.slice(start, starts[i + 1] ?? patch.length));
}

/** The kind of change a file section's header names. */
export function sectionStatus(section: string): GitFileStatus {
  const at = section.indexOf('\n@@');
  const head = at < 0 ? section : section.slice(0, at);
  if (/^new file mode /m.test(head)) return 'added';
  if (/^deleted file mode /m.test(head)) return 'deleted';
  if (/^rename from /m.test(head)) return 'renamed';
  if (/^copy from /m.test(head)) return 'copied';
  return 'modified';
}

/** A file section's hunks, without its header; null when it has none (binary, mode only). */
function sectionHunks(section: string): string | null {
  const at = section.indexOf('\n@@');
  return at < 0 ? null : section.slice(at + 1);
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** An untracked file as an all-added patch; null when it can't be shown as text. */
export function addedPatch(text: string): { patch: string; lines: number } | null {
  if (text.includes('\0')) return null;
  if (text === '') return { patch: '', lines: 0 };
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = body.split('\n');
  return {
    patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`,
    lines: lines.length,
  };
}

interface ReviewedTree {
  review: GitReview;
  /** Where the review ran: the worktree's root folder. */
  root: string;
  /** Uncommitted state by path, as `git status` reports it. */
  changes: ReadonlyMap<string, GitFileChange>;
}

type ReadResult = { ok: true; tree: ReviewedTree } | { ok: false; error: string };

export interface GitReviewerOptions {
  store: BoardStore;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  /** Whether `claude --worktree` is available; only called for a review that gets read. */
  parallel: () => Promise<boolean>;
  /** After a commit or discard: the board shows the new status straight away. */
  onChanged?: (projectId: string) => void;
  /** Refuses a project whose folder may no longer be used (the library check). */
  guard?: (projectId: string) => Promise<ActionResult | null>;
  read?: GitRunner;
  write?: GitRunner;
  gh?: (dir: string, args: readonly string[]) => Promise<string>;
  now?: () => number;
}

/**
 * The working tree of a project or one of its worktrees against what it branched from: its
 * upstream's merge base, else the default branch's, else the last commit. Reading runs no program
 * from the repository; Commit and Discard check again that the review is still current.
 */
export class GitReviewer implements ReviewSource {
  private readonly store: BoardStore;
  private readonly log: GitReviewerOptions['logger'];
  private readonly options: GitReviewerOptions;
  private readonly run: GitRunner;
  private readonly write: GitRunner;
  private readonly gh: NonNullable<GitReviewerOptions['gh']>;
  private readonly now: () => number;
  private readonly badges = new Map<string, { at: number; badge: PullRequestBadge | null }>();

  constructor(options: GitReviewerOptions) {
    this.options = options;
    this.store = options.store;
    this.log = options.logger;
    this.run = options.read ?? gitRunner({ timeout: READ_TIMEOUT_MS, maxBuffer: READ_MAX_OUTPUT });
    this.write = options.write ?? runWritingGit;
    this.gh = options.gh ?? runGh;
    this.now = options.now ?? Date.now;
  }

  async read(projectId: string, worktree: string | null): Promise<ReviewOutcome> {
    const read = await this.readTree(projectId, worktree);
    return read.ok ? { ok: true, review: read.tree.review } : read;
  }

  /** The folder under review: the project's own, or a checkout git still lists for it. */
  private async locate(
    projectId: string,
    worktree: string | null,
  ): Promise<{ ok: true; dir: string; main: string | null } | { ok: false; error: string }> {
    const project = this.store.state.projects[projectId];
    if (!project) return { ok: false, error: ROUTE_ERRORS.unknownProject };
    let listed: GitWorktree[];
    try {
      listed = parseGitWorktrees(await this.run(project.path, GIT_WORKTREE_ARGS));
    } catch (err) {
      return { ok: false, error: this.readError(err) };
    }
    const main = listed.find((entry) => entry.main)?.branch ?? null;
    if (worktree === null) return { ok: true, dir: project.path, main };
    const found = listed.find((entry) => entry.id === worktree);
    return found
      ? { ok: true, dir: found.path, main }
      : { ok: false, error: REVIEW_ERRORS.unknownWorktree };
  }

  private async readTree(projectId: string, worktree: string | null): Promise<ReadResult> {
    const located = await this.locate(projectId, worktree);
    if (!located.ok) return located;
    const { dir, main } = located;
    try {
      if (configRunsCommands(await this.run(dir, GIT_CONFIG_ARGS))) {
        return { ok: false, error: REVIEW_ERRORS.configRunsCommands };
      }
      const root = (await this.run(dir, ['rev-parse', '--show-toplevel'])).trim();
      const statusOut = await this.run(root, REVIEW_STATUS_ARGS);
      const status = parseGitStatus(statusOut, Number.MAX_SAFE_INTEGER);
      const base = await this.base(root, status.head, status.upstream, status.branch, main);
      const numstat = parseNumstat(
        await this.run(root, [...DIFF_ARGS, '--numstat', '-z', base.commit, '--']),
      );
      const patch = await this.run(root, [...DIFF_ARGS, '--unified=3', base.commit, '--']);
      const sections = splitPatch(patch);
      // Sections and numstat come from one diff, in one order; a conflict can break that.
      const aligned = sections.length === numstat.length;
      const changes = new Map(status.files.map((file) => [file.path, file]));
      const reviewBudget = { left: REVIEW_MAX_TOTAL_PATCH };
      const seen = new Set<string>();
      const all: GitReviewFile[] = [];
      for (const [i, entry] of numstat.entries()) {
        seen.add(entry.path);
        const section = aligned ? sections[i] : undefined;
        all.push(reviewedFile(entry, section, changes.get(entry.path), reviewBudget));
      }
      const fingerprints: string[] = [];
      for (const file of status.files) {
        if (seen.has(file.path)) continue;
        if (file.status === 'untracked') {
          const added = await untrackedFile(root, file.path, reviewBudget);
          fingerprints.push(added.fingerprint);
          all.push(added.file);
        } else {
          // Back to what the base has, but still different from the last commit.
          all.push(unchangedFromBase(file));
        }
      }
      all.sort((a, b) => a.path.localeCompare(b.path));
      const files = all.slice(0, REVIEW_MAX_FILES);
      const review: GitReview = {
        worktree,
        branch: status.branch,
        head: status.head,
        base: { ref: base.ref, commit: base.commit === EMPTY_TREE ? null : base.commit },
        revision: sha([status.head, base.commit, statusOut, patch, ...fingerprints].join('\0')),
        files,
        unlisted: all.length - files.length,
        parallel: await this.options.parallel().catch(() => false),
        readAt: this.now(),
      };
      return { ok: true, tree: { review, root, changes } };
    } catch (err) {
      return { ok: false, error: this.readError(err) };
    }
  }

  /** The nearest commit shared with what the branch came from. */
  private async base(
    root: string,
    head: string | null,
    upstream: string | null,
    branch: string | null,
    mainBranch: string | null,
  ): Promise<{ ref: string | null; commit: string }> {
    if (head === null) return { ref: null, commit: EMPTY_TREE };
    const remoteHead = await this.run(root, [
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ]).then(
      (out) => out.trim() || null,
      () => null,
    );
    const candidates = [upstream, remoteHead, mainBranch, 'main', 'master'];
    for (const ref of candidates) {
      if (!ref || ref === branch) continue;
      const commit = await this.run(root, ['merge-base', 'HEAD', ref]).then(
        (out) => out.trim(),
        () => '',
      );
      if (commit) return { ref, commit };
    }
    return { ref: null, commit: head };
  }

  private readError(err: unknown): string {
    if (/not a git repository|cannot change to/i.test(stderrOf(err))) return REVIEW_ERRORS.notRepo;
    if (codeOf(err) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return REVIEW_ERRORS.tooLarge;
    this.log.warn({ err }, 'git review failed');
    return REVIEW_ERRORS.failed;
  }

  /** The review as it stands, if it's still the one the user looked at. */
  private async current(
    projectId: string,
    worktree: string | null,
    revision: string,
  ): Promise<ReadResult> {
    const refused = await this.options.guard?.(projectId);
    if (refused) return { ok: false, error: refused.ok ? REVIEW_ERRORS.failed : refused.error };
    const read = await this.readTree(projectId, worktree);
    if (read.ok && read.tree.review.revision !== revision) {
      return { ok: false, error: REVIEW_ERRORS.changed };
    }
    return read;
  }

  /** Stages the files the review showed as uncommitted, and commits only those. */
  async commit({
    projectId,
    worktree,
    revision,
    message,
  }: Extract<UiAction, { kind: 'git.commit' }>): Promise<ActionResult> {
    const read = await this.current(projectId, worktree ?? null, revision);
    if (!read.ok) return read;
    const { review, root, changes } = read.tree;
    const files = review.files.filter((file) => file.uncommitted);
    if (files.length === 0) return { ok: false, error: REVIEW_ERRORS.nothingToCommit };
    if (files.some((file) => changes.get(file.path)?.status === 'conflicted')) {
      return { ok: false, error: REVIEW_ERRORS.conflicts };
    }
    // Already staged deletions and rename sources are gone from the index, so `add` can't name them.
    const staged = (change: GitFileChange | undefined) =>
      change?.status === 'deleted' && !change.unstaged;
    const added = files.filter((file) => !staged(changes.get(file.path))).map((file) => file.path);
    const origins = files.flatMap((file) => changes.get(file.path)?.origPath ?? []);
    const paths = [...new Set([...files.map((file) => file.path), ...origins])];
    try {
      if (added.length > 0) {
        await this.write(root, ['--literal-pathspecs', 'add', '-A', '--', ...added]);
      }
      await this.write(root, ['--literal-pathspecs', 'commit', '-m', message, '--', ...paths]);
    } catch (err) {
      this.log.debug({ err }, 'git commit failed');
      return { ok: false, error: REVIEW_ERRORS.commitFailed, detail: detailOf(err) };
    }
    this.options.onChanged?.(projectId);
    return { ok: true };
  }

  /** Puts one file back as the last commit has it; a file git doesn't track yet is deleted. */
  async discard({
    projectId,
    worktree,
    revision,
    path,
  }: Extract<UiAction, { kind: 'git.discard' }>): Promise<ActionResult> {
    const read = await this.current(projectId, worktree ?? null, revision);
    if (!read.ok) return read;
    const { review, root, changes } = read.tree;
    const file = review.files.find((candidate) => candidate.path === path);
    const change = changes.get(path);
    if (!file?.uncommitted || !change) return { ok: false, error: REVIEW_ERRORS.notDiscardable };
    try {
      for (const args of discardSteps(change, review.head !== null)) {
        await this.write(root, ['--literal-pathspecs', ...args]);
      }
    } catch (err) {
      this.log.debug({ err }, 'git discard failed');
      return { ok: false, error: REVIEW_ERRORS.discardFailed, detail: detailOf(err) };
    }
    this.options.onChanged?.(projectId);
    return { ok: true };
  }

  /** The branch's pull request, or null when `gh` is missing, signed out or finds none. */
  async pullRequest(projectId: string, worktree: string | null): Promise<PullRequestBadge | null> {
    const located = await this.locate(projectId, worktree);
    if (!located.ok) return null;
    const cached = this.badges.get(located.dir);
    if (cached && this.now() - cached.at < GH_CACHE_MS) return cached.badge;
    const badge = await this.readPullRequest(located.dir);
    this.badges.set(located.dir, { at: this.now(), badge });
    return badge;
  }

  private async readPullRequest(dir: string): Promise<PullRequestBadge | null> {
    try {
      if (configRunsCommands(await this.run(dir, GIT_CONFIG_ARGS))) return null;
      const out = await this.gh(dir, [
        'pr',
        'view',
        '--json',
        'number,title,url,state,isDraft,statusCheckRollup',
      ]);
      return parsePullRequest(out);
    } catch {
      return null;
    }
  }
}

/** The git tree with nothing in it: the base of a repository without a commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function reviewedFile(
  entry: NumstatEntry,
  section: string | undefined,
  change: GitFileChange | undefined,
  budget: { left: number },
): GitReviewFile {
  const hunks = section === undefined ? null : sectionHunks(section);
  const size = hunks === null ? 0 : Buffer.byteLength(hunks);
  const tooLarge = size > REVIEW_MAX_FILE_PATCH || size > budget.left;
  if (!tooLarge) budget.left -= size;
  return {
    path: entry.path,
    origPath: entry.origPath,
    status:
      change?.status === 'conflicted'
        ? 'conflicted'
        : section !== undefined
          ? sectionStatus(section)
          : (change?.status ?? 'modified'),
    added: entry.added,
    removed: entry.removed,
    binary: entry.binary,
    patch: tooLarge ? null : hunks,
    tooLarge,
    sig: sha(section ?? `${entry.path}:${entry.added}:${entry.removed}`).slice(0, 16),
    uncommitted: change !== undefined,
  };
}

function unchangedFromBase(file: GitFileChange): GitReviewFile {
  return {
    path: file.path,
    origPath: file.origPath,
    status: file.status,
    added: 0,
    removed: 0,
    binary: false,
    patch: '',
    tooLarge: false,
    sig: sha(`${file.path}:${file.status}`).slice(0, 16),
    uncommitted: true,
  };
}

/** An untracked file's review row. Only a plain file is read: a link might point anywhere. */
async function untrackedFile(
  root: string,
  path: string,
  budget: { left: number },
): Promise<{ file: GitReviewFile; fingerprint: string }> {
  const row: GitReviewFile = {
    path,
    origPath: null,
    status: 'untracked',
    added: 0,
    removed: 0,
    binary: false,
    patch: null,
    tooLarge: false,
    sig: '',
    uncommitted: true,
  };
  const full = join(root, path);
  const info = await lstat(full).catch(() => null);
  const fingerprint = `${path}:${info?.size ?? 0}:${info?.mtimeMs ?? 0}`;
  const finished = (file: GitReviewFile) => ({
    file: { ...file, sig: sha(fingerprint).slice(0, 16) },
    fingerprint,
  });
  if (!info?.isFile()) return finished(row);
  if (info.size > REVIEW_MAX_FILE_PATCH || info.size > budget.left) {
    return finished({ ...row, tooLarge: true });
  }
  const text = await readFile(full, 'utf8').catch(() => null);
  const added = text === null ? null : addedPatch(text);
  if (!added) return finished({ ...row, binary: text !== null });
  budget.left -= info.size;
  return finished({ ...row, added: added.lines, patch: added.patch });
}

/** The git commands that undo one uncommitted change. */
export function discardSteps(change: GitFileChange, hasCommit: boolean): string[][] {
  const { path, origPath, status } = change;
  if (status === 'untracked') return [['clean', '-f', '--', path]];
  const restore = (target: string) => [
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    target,
  ];
  if (!hasCommit || status === 'added' || status === 'copied') return [['rm', '-f', '--', path]];
  if (status === 'renamed' && origPath) return [['rm', '-f', '--', path], restore(origPath)];
  return [restore(path)];
}

const GhPullRequest = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  statusCheckRollup: z
    .array(
      z.object({
        status: z.string().optional(),
        state: z.string().optional(),
        conclusion: z.string().nullish(),
      }),
    )
    .nullish(),
});

const FAILED_CHECKS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED']);
const OPEN_CHECKS = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'EXPECTED']);

/** `gh pr view --json`'s output as a badge; null for anything else. */
export function parsePullRequest(stdout: string): PullRequestBadge | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = GhPullRequest.safeParse(json);
  if (!parsed.success) return null;
  const { number, title, url, state, isDraft, statusCheckRollup } = parsed.data;
  const results = (statusCheckRollup ?? []).map(
    (check) => check.conclusion || check.state || check.status || '',
  );
  const checks = results.some((r) => FAILED_CHECKS.has(r))
    ? 'failing'
    : results.some((r) => OPEN_CHECKS.has(r))
      ? 'pending'
      : results.length > 0
        ? 'passing'
        : 'none';
  const shown = isDraft && state === 'OPEN' ? 'draft' : state.toLowerCase();
  const response = PullRequestResponse.safeParse({
    pr: { number, title, url, state: shown, checks },
  });
  return response.success ? response.data.pr : null;
}

const CLAUDE_HELP_TIMEOUT_MS = 5_000;

/**
 * Whether the user's `claude` has `--worktree`, from its help text. A yes lasts; a no is asked
 * again next time, since installing Claude Code doesn't need a board restart.
 */
export function worktreeFlagProbe(
  help: () => Promise<string> = claudeHelp,
): () => Promise<boolean> {
  let known = false;
  return async () => {
    if (known) return true;
    known = /(?:^|\s)--worktree\b/m.test(await help().catch(() => ''));
    return known;
  };
}

const claudeHelp = () =>
  new Promise<string>((resolve, reject) => {
    execFile(
      process.env.YARDMASTER_CLAUDE_BIN || 'claude',
      ['--help'],
      { timeout: CLAUDE_HELP_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

export const PARALLEL_COMMAND = 'claude --worktree';

/**
 * `git.commit`, `git.discard`, and `session.parallel`: a terminal running the user's `claude`,
 * which makes the worktree, asks about the folder as usual, and offers to remove it on exit.
 */
export function createReviewActions(options: {
  source: ReviewSource;
  parallel: () => Promise<boolean>;
  terminalCreate: ActionHandler<'terminal.create'>;
}): Pick<ActionHandlers, 'git.commit' | 'git.discard' | 'session.parallel'> {
  const { source, parallel, terminalCreate } = options;
  return {
    'git.commit': (action) => source.commit(action),
    'git.discard': (action) => source.discard(action),
    'session.parallel': async ({ projectId }) => {
      if (!(await parallel())) return { ok: false, error: REVIEW_ERRORS.noWorktreeFlag };
      return terminalCreate({
        kind: 'terminal.create',
        projectId,
        name: 'Parallel session',
        command: PARALLEL_COMMAND,
      });
    },
  };
}

const codeOf = (err: unknown) =>
  typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;

const stderrOf = (err: unknown) => {
  const stderr =
    typeof err === 'object' && err !== null ? (err as { stderr?: unknown }).stderr : undefined;
  return typeof stderr === 'string' ? stderr : '';
};

/** The end of what git printed: a hook's or signer's complaint comes last. */
function detailOf(err: unknown): string {
  const text = stderrOf(err).trim();
  return text.length > MAX_DETAIL ? `…${text.slice(-MAX_DETAIL)}` : text;
}

/**
 * Git for Commit and Discard: the user's own config, system file included, with their hooks and
 * signing. It never prompts. `core.fsmonitor` stays off: only a refused repository could set it.
 */
const runWritingGit: GitRunner = (dir, args) =>
  new Promise((resolve, reject) => {
    const { GIT_CONFIG_NOSYSTEM: _system, ...env } = gitEnv();
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', dir, ...args],
      { timeout: WRITE_TIMEOUT_MS, maxBuffer: READ_MAX_OUTPUT, encoding: 'utf8', env },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve(stdout);
      },
    );
  });

const runGh: NonNullable<GitReviewerOptions['gh']> = (dir, args) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.YARDMASTER_GH_BIN || 'gh',
      [...args],
      {
        cwd: dir,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: READ_MAX_OUTPUT,
        encoding: 'utf8',
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });

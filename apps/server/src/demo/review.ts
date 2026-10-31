import { createHash } from 'node:crypto';
import {
  type GitFileChange,
  type GitInfo,
  type GitReview,
  type GitReviewFile,
  type GitWorktree,
  type PullRequestBadge,
  projectIdFromPath,
  REVIEW_ERRORS,
  type UiAction,
} from '@yardmaster/protocol';
import type { ActionResult } from '../actions.js';
import type { ReviewOutcome, ReviewSource } from '../git-review.js';
import type { BoardStore } from '../store.js';

/** The demo project with a second checkout, so the board shows a worktree without any git. */
export const DEMO_WORKTREE_PROJECT = 'orbit-api';
const DEMO_WORKTREE_NAME = 'rate-limits';

export function demoWorktrees(path: string, branch: string): GitWorktree[] {
  const linked = `${path}/.claude/worktrees/${DEMO_WORKTREE_NAME}`;
  return [
    { id: projectIdFromPath(path), path, branch, head: null, main: true },
    {
      id: projectIdFromPath(linked),
      path: linked,
      branch: `worktree-${DEMO_WORKTREE_NAME}`,
      head: null,
      main: false,
    },
  ];
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A believable small diff for any file; the demo has no contents to compare. */
function syntheticPatch(path: string, status: GitFileChange['status']): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\W+/g, '_');
  if (status === 'added' || status === 'untracked') {
    return `@@ -0,0 +1,4 @@\n+export const ${name} = {\n+  retries: 3,\n+  timeoutMs: 2_000,\n+};\n`;
  }
  return [
    '@@ -12,7 +12,8 @@ export function configure() {',
    '   const options = defaults();',
    `-  options.name = '${name}';`,
    `+  options.name = '${name}-v2';`,
    '-  options.retries = 2;',
    '+  options.retries = 3;',
    '+  options.timeoutMs = 2_000;',
    '   validate(options);',
    '   return options;',
    ' }',
    '',
  ].join('\n');
}

function reviewFile(file: GitFileChange): GitReviewFile {
  const patch = syntheticPatch(file.path, file.status);
  const added = (patch.match(/^\+/gm) ?? []).length;
  const removed = (patch.match(/^-/gm) ?? []).length;
  return {
    path: file.path,
    origPath: file.origPath,
    status: file.status,
    added,
    removed,
    binary: false,
    patch,
    tooLarge: false,
    sig: sha(`${file.path}\0${patch}`).slice(0, 16),
    uncommitted: true,
  };
}

/** A branch's worth of already committed work, so a review isn't only the uncommitted files. */
const COMMITTED: GitFileChange = {
  path: 'src/branch/already-committed.ts',
  origPath: null,
  status: 'modified',
  staged: false,
  unstaged: false,
};

const WORKTREE_FILE: GitFileChange = {
  path: 'src/limits/token-bucket.ts',
  origPath: null,
  status: 'added',
  staged: false,
  unstaged: true,
};

export interface DemoReviewBoard {
  readonly store: BoardStore;
  commitFiles(projectId: string): void;
  discardFile(projectId: string, path: string): void;
}

/** The review on the synthetic board: it reads the demo's git status and touches no disk. */
export class DemoReview implements ReviewSource {
  constructor(private readonly board: DemoReviewBoard) {}

  private snapshot(git: GitInfo, worktree: string | null): GitReview {
    const linked = (git.worktrees ?? []).find((w) => w.id === worktree && !w.main);
    const onBranch = git.branch !== 'main' && !linked;
    const files = linked
      ? [reviewFile(WORKTREE_FILE)]
      : [
          ...git.files.map(reviewFile),
          ...(onBranch ? [{ ...reviewFile(COMMITTED), uncommitted: false }] : []),
        ];
    return {
      worktree,
      branch: linked?.branch ?? git.branch,
      head: git.head,
      base: { ref: git.upstream ?? 'origin/main', commit: git.commits.at(-1)?.hash ?? null },
      revision: sha(`${worktree}\0${git.head}\0${files.map((f) => f.sig).join('\0')}`),
      files,
      unlisted: 0,
      parallel: true,
      readAt: git.updatedAt,
    };
  }

  private git(projectId: string): GitInfo | null {
    return this.board.store.state.projects[projectId]?.git ?? null;
  }

  async read(projectId: string, worktree: string | null): Promise<ReviewOutcome> {
    const git = this.git(projectId);
    if (!git) return { ok: false, error: REVIEW_ERRORS.notRepo };
    return { ok: true, review: this.snapshot(git, worktree) };
  }

  async pullRequest(projectId: string): Promise<PullRequestBadge | null> {
    const git = this.git(projectId);
    if (!git?.branch || git.branch === 'main') return null;
    return {
      number: 128,
      title: `Work on ${git.branch}`,
      url: 'https://example.com/acme/pull/128',
      state: 'open',
      checks: 'passing',
    };
  }

  async commit({
    projectId,
    worktree,
    revision,
  }: Extract<UiAction, { kind: 'git.commit' }>): Promise<ActionResult> {
    const git = this.git(projectId);
    if (!git) return { ok: false, error: REVIEW_ERRORS.notRepo };
    if (this.snapshot(git, worktree ?? null).revision !== revision) {
      return { ok: false, error: REVIEW_ERRORS.changed };
    }
    this.board.commitFiles(projectId);
    return { ok: true };
  }

  async discard({
    projectId,
    worktree,
    revision,
    path,
  }: Extract<UiAction, { kind: 'git.discard' }>): Promise<ActionResult> {
    const git = this.git(projectId);
    if (!git) return { ok: false, error: REVIEW_ERRORS.notRepo };
    if (this.snapshot(git, worktree ?? null).revision !== revision) {
      return { ok: false, error: REVIEW_ERRORS.changed };
    }
    this.board.discardFile(projectId, path);
    return { ok: true };
  }
}

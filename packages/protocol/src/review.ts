import { z } from 'zod';
import { GitFileStatus, ProjectId, Timestamp } from './domain.js';

/** Files a review lists; anything past this stays out of the review and of its commit. */
export const REVIEW_MAX_FILES = 300;
/** A file's diff above this size isn't sent. */
export const REVIEW_MAX_FILE_PATCH = 256 * 1024;
/** All of a review's diffs together; files past it arrive without one. */
export const REVIEW_MAX_TOTAL_PATCH = 3 * 1024 * 1024;

export const MAX_COMMIT_MESSAGE = 10_000;

/** Names one exact state of the files under review, so an action can't apply to a newer one. */
export const GitReviewRevision = z.string().regex(/^[0-9a-f]{64}$/);

export const GitReviewFile = z.object({
  path: z.string().min(1),
  origPath: z.string().nullable(),
  status: GitFileStatus,
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  binary: z.boolean(),
  /** Unified diff, from the first `@@`. Null when it's binary, too large or unavailable. */
  patch: z.string().nullable(),
  /** Over the size limits: `patch` is null but the file has text changes. */
  tooLarge: z.boolean(),
  /** Changes with this file's content, so a "viewed" mark can lapse when it changes. */
  sig: z.string().min(1),
  /** Differs from the last commit, so Commit and Discard apply to it. */
  uncommitted: z.boolean(),
});
export type GitReviewFile = z.infer<typeof GitReviewFile>;

export const GitReview = z.object({
  /** The worktree under review; null for the project's own folder. */
  worktree: ProjectId.nullable(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  /** What the working tree is compared with. */
  base: z.object({
    /** `origin/main`, or null when the comparison is the last commit. */
    ref: z.string().nullable(),
    commit: z.string().nullable(),
  }),
  revision: GitReviewRevision,
  files: z.array(GitReviewFile).max(REVIEW_MAX_FILES),
  /** Changed files beyond `REVIEW_MAX_FILES`. */
  unlisted: z.number().int().nonnegative(),
  /** The user's `claude` can start a session in its own worktree. */
  parallel: z.boolean(),
  readAt: Timestamp,
});
export type GitReview = z.infer<typeof GitReview>;

export const PullRequestChecks = z.enum(['passing', 'failing', 'pending', 'none']);
export type PullRequestChecks = z.infer<typeof PullRequestChecks>;

/** `GET /api/projects/:projectId/review/pr`: read-only, from the user's own `gh`. */
export const PullRequestBadge = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url({ protocol: /^https$/ }),
  state: z.enum(['open', 'merged', 'closed', 'draft']),
  checks: PullRequestChecks,
});
export type PullRequestBadge = z.infer<typeof PullRequestBadge>;

export const PullRequestResponse = z.object({ pr: PullRequestBadge.nullable() });
export type PullRequestResponse = z.infer<typeof PullRequestResponse>;

/** Errors of the review route and its actions, as sent to the board. */
export const REVIEW_ERRORS = {
  notRepo: 'not_a_repo',
  unknownWorktree: 'unknown_worktree',
  configRunsCommands: 'config_runs_commands',
  tooLarge: 'review_too_large',
  failed: 'review_failed',
  changed: 'review_changed',
  nothingToCommit: 'nothing_to_commit',
  conflicts: 'commit_conflicts',
  commitFailed: 'commit_failed',
  notDiscardable: 'not_discardable',
  discardFailed: 'discard_failed',
  noWorktreeFlag: 'no_worktree_flag',
} as const;

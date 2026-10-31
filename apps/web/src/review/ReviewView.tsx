import {
  type GitFileStatus,
  type GitReview,
  type GitReviewFile,
  type GitWorktree,
  type Project,
  type PullRequestBadge,
  REVIEW_ERRORS,
  sessionDisplayName,
} from '@yardmaster/protocol';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  GitBranch,
  GitPullRequest,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { langFor } from '../claude/highlight.js';
import { DiffView, diffLayoutPreference } from '../claude/tools/DiffView.js';
import { extensionOf } from '../claude/tools/results.js';
import { selectSessionsByProject, useBoardClient, useBoardList } from '../data/index.js';
import { draftKey, drafts } from '../drafts/drafts.js';
import { FILE_MARK } from '../git/GitPanel.js';
import { splitPath } from '../git/model.js';
import { countOf } from '../plural.js';
import { usePreference } from '../prefs.js';
import { sessionHref } from '../routes.js';
import { actionErrorText } from '../terminal/stack.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import {
  fixPrompt,
  fixSession,
  hunksFromPatch,
  isViewed,
  nextUnviewed,
  reviewTotals,
  toggleViewed,
} from './model.js';
import { usePullRequest, useReview, useViewed } from './useReview.js';

const ERROR_TEXT: Record<string, string> = {
  [REVIEW_ERRORS.notRepo]: 'This folder is not a git repository',
  [REVIEW_ERRORS.configRunsCommands]:
    'Skipped: this repository’s config can run programs, so the board doesn’t read its diff',
  [REVIEW_ERRORS.unknownWorktree]: 'That worktree is gone',
  [REVIEW_ERRORS.tooLarge]: 'These changes are too large to review here',
};

const STATUS_WORD: Record<GitFileStatus, string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  typechange: 'type changed',
  untracked: 'new',
  conflicted: 'conflicted',
};

export interface ReviewViewProps {
  project: Project;
  /** The linked worktree under review (`GitWorktree.id`); the project's own folder without it. */
  worktree?: string;
  /** Phones: a file list, then one file's diff on its own page. */
  phone: boolean;
  onClose: () => void;
}

/** Review changes: the working tree against what it branched from, file by file. */
export function ReviewView({ project, worktree, phone, onClose }: ReviewViewProps) {
  const { state, stale, showNewer, reload } = useReview(project.id, worktree);
  const pr = usePullRequest(project.id, worktree);
  const listed = project.git?.worktrees?.find((entry) => entry.id === worktree);
  return (
    <section
      aria-label="Review changes"
      data-review={worktree ?? project.id}
      className="flex h-full min-h-0 flex-col bg-bg-1"
    >
      {!phone && (
        <header className="flex min-w-0 shrink-0 items-center gap-3 border-line border-b px-5 py-3">
          <h2 className="shrink-0 font-medium text-body text-text-1">Review changes</h2>
          {state.status === 'ready' && <BaseLine review={state.review} />}
          {pr && <PullRequestChip pr={pr} />}
          <span className="flex-1" />
          <LayoutToggle />
          <IconButton
            label="Close the review"
            size="sm"
            data-review-close
            icon={<X className="size-4" strokeWidth={1.5} />}
            onClick={onClose}
          />
        </header>
      )}
      {phone && state.status === 'ready' && (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-line border-b px-4 py-2">
          <BaseLine review={state.review} />
          {pr && <PullRequestChip pr={pr} />}
        </div>
      )}
      {stale && (
        <div
          data-review-stale
          role="status"
          className="flex shrink-0 items-center gap-3 border-line border-b bg-bg-2 px-5 py-2 text-body-sm text-text-2 max-md:px-4"
        >
          <span className="min-w-0 flex-1">The files changed since this diff was read.</span>
          <Button size="sm" onClick={showNewer}>
            <RefreshCw aria-hidden className="size-3.5" strokeWidth={1.5} />
            Show the new diff
          </Button>
        </div>
      )}
      {state.status === 'loading' && (
        <p className="p-5 text-body-sm text-text-2">Reading the diff…</p>
      )}
      {state.status === 'error' && (
        <p data-review-error className="p-5 text-body-sm text-text-2">
          {ERROR_TEXT[state.error] ?? 'Could not read the diff'}
        </p>
      )}
      {state.status === 'ready' && (
        <ReviewBody
          key={state.review.worktree ?? project.id}
          project={project}
          review={state.review}
          worktree={worktree}
          worktreeEntry={listed}
          phone={phone}
          reload={reload}
        />
      )}
    </section>
  );
}

function BaseLine({ review }: { review: GitReview }) {
  const base = review.base.ref
    ? `against ${review.base.ref}${review.base.commit ? ` at ${review.base.commit.slice(0, 7)}` : ''}`
    : review.base.commit
      ? 'against the last commit'
      : 'no commits yet';
  return (
    <p className="flex min-w-0 items-center gap-2 font-mono text-meta text-text-2">
      {review.branch && (
        <span className="flex min-w-0 items-center gap-1" title={review.branch}>
          <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{review.branch}</span>
        </span>
      )}
      <span data-review-base className="min-w-0 truncate" title={base}>
        {base}
      </span>
    </p>
  );
}

const CHECKS_TONE = {
  passing: 'text-st-ok-ink',
  failing: 'text-st-err-ink',
  pending: 'text-st-wait-ink',
  none: 'text-text-3',
} as const;

function PullRequestChip({ pr }: { pr: PullRequestBadge }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      data-review-pr
      title={pr.title}
      className="flex shrink-0 items-center gap-1.5 rounded-control font-mono text-meta text-text-2 transition-colors duration-fast hover:text-text-1 touch:min-h-11"
    >
      <GitPullRequest aria-hidden className="size-3.5" strokeWidth={1.5} />
      <span className="tabular">#{pr.number}</span>
      <span>{pr.state}</span>
      {pr.checks !== 'none' && <span className={CHECKS_TONE[pr.checks]}>checks {pr.checks}</span>}
    </a>
  );
}

function LayoutToggle() {
  const layout = usePreference(diffLayoutPreference);
  return (
    <fieldset aria-label="Diff layout" className="flex shrink-0 items-center gap-0.5">
      {(['unified', 'split'] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={layout === option}
          onClick={() => diffLayoutPreference.set(option)}
          className={cx(
            'rounded-control px-2 py-1 text-label capitalize transition-colors duration-fast',
            layout === option ? 'bg-bg-2 text-text-1' : 'text-text-3 hover:text-text-2',
          )}
        >
          {option}
        </button>
      ))}
    </fieldset>
  );
}

function ReviewBody({
  project,
  review,
  worktree,
  worktreeEntry,
  phone,
  reload,
}: {
  project: Project;
  review: GitReview;
  worktree: string | undefined;
  worktreeEntry: GitWorktree | undefined;
  phone: boolean;
  reload: () => Promise<void>;
}) {
  const [marks, setMarks] = useViewed(`${project.id}:${worktree ?? ''}`);
  const [picked, setPicked] = useState<string | null>(null);
  const files = review.files;
  const fallback = phone ? null : (files[0]?.path ?? null);
  const selected = files.find((file) => file.path === picked) ?? null;
  const shown = selected ?? files.find((file) => file.path === fallback) ?? null;
  const viewed = files.filter((file) => isViewed(marks, file)).length;
  const totals = reviewTotals(files);

  const toggle = (file: GitReviewFile) => {
    const wasViewed = isViewed(marks, file);
    const next = toggleViewed(marks, file);
    setMarks(next);
    // Marking the open file read moves on to the next one, on phones back to the list.
    if (!wasViewed && file.path === shown?.path) {
      setPicked(phone ? null : (nextUnviewed(files, next, file.path) ?? file.path));
    }
  };

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 p-5">
        <p className="flex items-center gap-1.5 text-body-sm text-text-2">
          <Check aria-hidden className="size-3.5 text-st-ok-ink" strokeWidth={1.75} />
          No changes to review
        </p>
        {review.parallel && <ParallelButton project={project} />}
      </div>
    );
  }

  const list = (
    <div className="flex min-h-0 flex-1 flex-col md:max-w-80 md:border-line md:border-r">
      <p
        data-review-totals
        className="flex shrink-0 items-center gap-2 px-4 py-2 text-meta text-text-2 tabular"
      >
        <span>{countOf(files.length, 'file')}</span>
        <span className="font-mono text-st-ok-ink">+{totals.added}</span>
        <span className="font-mono text-st-err-ink">−{totals.removed}</span>
        <span className="flex-1" />
        <span data-review-viewed>
          {viewed} of {files.length} viewed
        </span>
      </p>
      <ul aria-label="Changed files" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            viewed={isViewed(marks, file)}
            active={!phone && file.path === shown?.path}
            phone={phone}
            onOpen={() => setPicked(file.path)}
            onToggle={() => toggle(file)}
          />
        ))}
        {review.unlisted > 0 && (
          <li className="px-2 py-1 text-meta text-text-2 tabular">
            {review.unlisted} more not listed
          </li>
        )}
      </ul>
      <CommitBox project={project} review={review} worktree={worktree} reload={reload} />
      {review.parallel && (
        <div className="shrink-0 border-line border-t px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <ParallelButton project={project} />
        </div>
      )}
    </div>
  );

  const diff = shown && (
    <FilePane
      key={shown.path}
      project={project}
      file={shown}
      review={review}
      worktree={worktree}
      worktreeEntry={worktreeEntry}
      viewed={isViewed(marks, shown)}
      phone={phone}
      onBack={phone ? () => setPicked(null) : undefined}
      onToggle={() => toggle(shown)}
      reload={reload}
    />
  );

  if (phone) return shown ? diff : list;
  return (
    <div className="flex min-h-0 flex-1">
      {list}
      {diff}
    </div>
  );
}

function FileMark({ status }: { status: GitFileStatus }) {
  const { mark, className } = FILE_MARK[status];
  return (
    <>
      <span aria-hidden className={cx('w-3 shrink-0 text-center font-mono text-label', className)}>
        {mark}
      </span>
      <span className="sr-only">{STATUS_WORD[status]}: </span>
    </>
  );
}

function FileRow({
  file,
  viewed,
  active,
  phone,
  onOpen,
  onToggle,
}: {
  file: GitReviewFile;
  viewed: boolean;
  active: boolean;
  phone: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const { dir, name } = splitPath(file.path);
  return (
    <li
      data-review-file={file.path}
      data-viewed={viewed || undefined}
      className={cx(
        'flex min-w-0 items-center gap-1 rounded-control transition-colors duration-fast',
        active ? 'bg-bg-2' : 'hover:bg-bg-2/60',
      )}
    >
      <label className="relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control touch:size-11">
        <input
          type="checkbox"
          checked={viewed}
          onChange={onToggle}
          aria-label={`Viewed ${file.path}`}
          className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
        />
        <span
          aria-hidden
          className={cx(
            'flex size-4 items-center justify-center rounded-[4px] border transition-colors duration-fast peer-focus-visible:shadow-focus',
            viewed ? 'border-text-2 bg-text-2 text-bg-1' : 'border-line-strong',
          )}
        >
          {viewed && <Check className="size-3" strokeWidth={2.5} />}
        </span>
      </label>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
        className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-control py-1 pr-2 text-left touch:min-h-11"
      >
        <FileMark status={file.status} />
        <span className="flex min-w-0 flex-1 items-baseline font-mono text-label">
          <span className={cx('min-w-0 truncate', viewed ? 'text-text-3' : 'text-text-1')}>
            {name}
          </span>
          {dir && <span className="ml-1.5 min-w-0 shrink-[100] truncate text-text-3">{dir}</span>}
        </span>
        <span className="shrink-0 font-mono text-meta tabular">
          {file.added > 0 && <span className="text-st-ok-ink">+{file.added}</span>}
          {file.added > 0 && file.removed > 0 && ' '}
          {file.removed > 0 && <span className="text-st-err-ink">−{file.removed}</span>}
        </span>
        {!file.uncommitted && (
          <span title="Already committed on this branch" className="shrink-0 text-meta text-text-3">
            committed
          </span>
        )}
        {phone && (
          <ChevronRight aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.5} />
        )}
      </button>
    </li>
  );
}

function FilePane({
  project,
  file,
  review,
  worktree,
  worktreeEntry,
  viewed,
  phone,
  onBack,
  onToggle,
  reload,
}: {
  project: Project;
  file: GitReviewFile;
  review: GitReview;
  worktree: string | undefined;
  worktreeEntry: GitWorktree | undefined;
  viewed: boolean;
  phone: boolean;
  onBack?: (() => void) | undefined;
  onToggle: () => void;
  reload: () => Promise<void>;
}) {
  const hunks = useMemo(() => (file.patch ? hunksFromPatch(file.patch) : []), [file.patch]);
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const [, navigate] = useLocation();
  const session = fixSession(sessions, project.git?.worktrees ?? [], worktreeEntry?.id ?? null);
  const askClaude = session
    ? () => {
        drafts.set(draftKey.session(session.id), fixPrompt(file.path));
        navigate(sessionHref(project.id, session.id));
      }
    : null;
  return (
    <div data-review-diff={file.path} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-line border-b px-4 py-2">
        {onBack && (
          <IconButton
            label="Back to the file list"
            size="sm"
            data-review-back
            icon={<ArrowLeft className="size-4" strokeWidth={1.5} />}
            onClick={onBack}
          />
        )}
        <FileMark status={file.status} />
        <h3
          className="min-w-0 flex-1 truncate font-mono text-label text-text-1"
          title={file.path}
          dir="auto"
        >
          {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
        </h3>
        <Button size="sm" variant="ghost" aria-pressed={viewed} data-review-mark onClick={onToggle}>
          <Check aria-hidden className="size-3.5" strokeWidth={1.75} />
          {viewed ? 'Viewed' : 'Mark viewed'}
        </Button>
        {askClaude && session && (
          <Button
            size="sm"
            variant="ghost"
            data-review-ask
            title={`Write it in ${sessionDisplayName(session)}'s message box`}
            onClick={askClaude}
          >
            <Sparkles aria-hidden className="size-3.5" strokeWidth={1.5} />
            Ask Claude to fix
          </Button>
        )}
        {file.uncommitted && (
          <DiscardButton
            project={project}
            file={file}
            revision={review.revision}
            worktree={worktree}
            reload={reload}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {file.patch && hunks.length > 0 ? (
          <DiffView
            id={`review:${project.id}:${file.path}:${file.sig}`}
            hunks={hunks}
            lang={langFor(extensionOf(file.path))}
            full
            {...(phone ? { layout: 'unified' as const } : {})}
          />
        ) : (
          <p className="p-4 text-body-sm text-text-2">{emptyDiffText(file)}</p>
        )}
      </div>
    </div>
  );
}

function emptyDiffText(file: GitReviewFile): string {
  if (file.binary) return 'Binary file: no text to show';
  if (file.tooLarge) return 'This diff is too large to show here';
  if (file.status === 'conflicted') return 'In conflict: resolve it in your editor';
  if (file.patch === '') return 'Empty, or back to what the base has';
  return 'No text changes to show';
}

function DiscardButton({
  project,
  file,
  revision,
  worktree,
  reload,
}: {
  project: Project;
  file: GitReviewFile;
  revision: string;
  worktree: string | undefined;
  reload: () => Promise<void>;
}) {
  const client = useBoardClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const discard = async () => {
    setBusy(true);
    const result = await client.action({
      kind: 'git.discard',
      projectId: project.id,
      ...(worktree ? { worktree } : {}),
      revision,
      path: file.path,
    });
    setBusy(false);
    setAsking(false);
    if (result.ok) toast.success(`Discarded ${file.path}`);
    else {
      toast.error(actionErrorText(result.error, 'Could not discard that file'), {
        description: result.detail,
      });
    }
    await reload();
  };
  if (!asking) {
    return (
      <Button size="sm" variant="ghost" data-review-discard onClick={() => setAsking(true)}>
        <Trash2 aria-hidden className="size-3.5" strokeWidth={1.5} />
        Discard
      </Button>
    );
  }
  const consequence =
    file.status === 'untracked' || file.status === 'added'
      ? 'This deletes the file.'
      : 'Uncommitted changes are lost.';
  return (
    <div
      role="alertdialog"
      aria-label={`Discard ${file.path}?`}
      data-review-confirm
      className="flex w-full min-w-0 items-center gap-2 rounded-control bg-bg-2 px-3 py-1.5 text-body-sm text-text-2"
    >
      <span className="min-w-0 flex-1">{consequence} Git can’t bring them back.</span>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
        Keep
      </Button>
      <Button size="sm" variant="primary" onClick={() => void discard()} disabled={busy}>
        Discard file
      </Button>
    </div>
  );
}

function CommitBox({
  project,
  review,
  worktree,
  reload,
}: {
  project: Project;
  review: GitReview;
  worktree: string | undefined;
  reload: () => Promise<void>;
}) {
  const client = useBoardClient();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const { uncommitted } = reviewTotals(review.files);
  if (uncommitted === 0) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || message.trim() === '') return;
    setBusy(true);
    const result = await client.action({
      kind: 'git.commit',
      projectId: project.id,
      ...(worktree ? { worktree } : {}),
      revision: review.revision,
      message: message.trim(),
    });
    setBusy(false);
    if (result.ok) {
      setMessage('');
      toast.success(`Committed ${countOf(uncommitted, 'file')}`);
    } else {
      toast.error(actionErrorText(result.error, 'Could not commit'), {
        description: result.detail,
      });
    }
    await reload();
  };
  return (
    <form
      onSubmit={(event) => void submit(event)}
      data-review-commit
      className="flex shrink-0 flex-col gap-2 border-line border-t p-4"
    >
      <label className="flex flex-col gap-1 text-label text-text-2">
        Commit message
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={2}
          maxLength={10_000}
          className="w-full resize-y rounded-control border border-line bg-bg-0 px-2.5 py-1.5 text-body-sm text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-focus"
        />
      </label>
      <Button type="submit" variant="primary" disabled={busy || message.trim() === ''}>
        {busy ? 'Committing…' : `Commit ${countOf(uncommitted, 'file')}`}
      </Button>
    </form>
  );
}

/** A session in its own worktree: the user's `claude` makes it, and removes it on exit. */
function ParallelButton({ project }: { project: Project }) {
  const client = useBoardClient();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      data-review-parallel
      disabled={busy}
      title="Opens a terminal running claude --worktree. On exit Claude offers to remove the worktree."
      onClick={() => {
        setBusy(true);
        void client.action({ kind: 'session.parallel', projectId: project.id }).then((result) => {
          setBusy(false);
          if (result.ok) toast.success('Started in a terminal, in its own worktree');
          else toast.error(actionErrorText(result.error, 'Could not start the session'));
        });
      }}
    >
      <GitBranch aria-hidden className="size-3.5" strokeWidth={1.5} />
      New parallel session
    </Button>
  );
}

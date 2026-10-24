import type { GitCommit, GitFileChange, GitFileStatus, GitInfo } from '@yardmaster/protocol';
import { ArrowDown, ArrowUp, Check, GitBranch } from 'lucide-react';
import { useState } from 'react';
import { ColumnHeading } from '../focus/ColumnHeading.js';
import { formatDateTime, formatWhen } from '../time.js';
import { cx } from '../ui/cx.js';
import { groupFiles, splitPath, syncState, unlistedCount } from './model.js';

const FILE_MARK: Record<GitFileStatus, { mark: string; className: string }> = {
  modified: { mark: 'M', className: 'text-st-work-ink' },
  added: { mark: 'A', className: 'text-st-ok-ink' },
  deleted: { mark: 'D', className: 'text-st-err-ink' },
  renamed: { mark: 'R', className: 'text-st-work-ink' },
  copied: { mark: 'C', className: 'text-st-work-ink' },
  typechange: { mark: 'T', className: 'text-st-work-ink' },
  untracked: { mark: 'U', className: 'text-text-3' },
  conflicted: { mark: '!', className: 'text-st-err-ink' },
};

/** Files shown before "Show more"; the groups share this budget in display order. */
export const GIT_FILES_SHOWN = 10;

export interface GitPanelProps {
  git: GitInfo | null;
  /** Clock for the commit times. */
  now: number;
}

/** Branch, upstream sync, changed files by status and the latest commits (F15). */
export function GitPanel({ git, now }: GitPanelProps) {
  if (!git) {
    return (
      <section aria-label="Git" data-git-panel>
        <ColumnHeading>Git</ColumnHeading>
        <p className="text-body-sm text-text-2">Not a git repository</p>
      </section>
    );
  }
  return (
    <section aria-label="Git" data-git-panel className="flex flex-col gap-4">
      <div>
        <ColumnHeading meta={git.dirty ? `${git.dirty} changed` : undefined}>Git</ColumnHeading>
        <BranchLine git={git} />
      </div>
      {git.dirty === 0 ? (
        <p className="flex items-center gap-1.5 text-body-sm text-text-3">
          <Check aria-hidden className="size-3.5 text-st-ok-ink" strokeWidth={1.75} />
          Working tree clean
        </p>
      ) : (
        <ChangedFiles git={git} />
      )}
      {git.commits.length > 0 && <Commits commits={git.commits} now={now} />}
    </section>
  );
}

function BranchLine({ git }: { git: GitInfo }) {
  const branch = git.branch ?? (git.head ? git.head.slice(0, 7) : 'no branch');
  const sync = syncState(git);
  return (
    <div className="-mt-2 flex min-w-0 flex-col gap-1 font-mono text-meta text-text-2">
      <p className="flex min-w-0 items-center gap-2 tabular">
        <span className="flex min-w-0 items-center gap-1" title={branch}>
          <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
          <span className="truncate text-text-2">{branch}</span>
          {git.detached && <span className="shrink-0">(detached)</span>}
        </span>
        {sync.kind === 'diverged' && sync.ahead > 0 && (
          <span className="flex shrink-0 items-center" title={`${sync.ahead} ahead`}>
            <ArrowUp aria-hidden className="size-3" strokeWidth={1.75} />
            {sync.ahead}
            <span className="sr-only"> ahead</span>
          </span>
        )}
        {sync.kind === 'diverged' && sync.behind > 0 && (
          <span className="flex shrink-0 items-center" title={`${sync.behind} behind`}>
            <ArrowDown aria-hidden className="size-3" strokeWidth={1.75} />
            {sync.behind}
            <span className="sr-only"> behind</span>
          </span>
        )}
      </p>
      <p className="truncate" title={git.upstream ?? undefined}>
        {sync.kind === 'none'
          ? 'No upstream'
          : sync.kind === 'synced'
            ? `Up to date with ${git.upstream}`
            : `Tracking ${git.upstream}`}
      </p>
    </div>
  );
}

function ChangedFiles({ git }: { git: GitInfo }) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupFiles(git.files);
  let budget = expanded ? Number.POSITIVE_INFINITY : GIT_FILES_SHOWN;
  const hidden = Math.max(0, git.files.length - GIT_FILES_SHOWN);
  const unlisted = unlistedCount(git);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        if (budget <= 0) return null;
        const shown = group.files.slice(0, budget);
        budget -= shown.length;
        return (
          <div key={group.status} data-git-group={group.status}>
            <h3 className="mb-1 flex items-baseline gap-1.5 text-label text-text-2">
              {group.label}
              <span className="tabular">{group.files.length}</span>
            </h3>
            <ul className="flex flex-col gap-0.5 font-mono text-label">
              {shown.map((file) => (
                <FileRow key={`${file.status}:${file.path}`} file={file} />
              ))}
            </ul>
          </div>
        );
      })}
      {(hidden > 0 || unlisted > 0) && (
        <div className="flex flex-col items-start gap-1 text-meta text-text-2">
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="rounded-control text-text-2 tabular transition-colors duration-fast hover:text-text-1 touch:min-h-11"
            >
              {expanded ? 'Show fewer' : `Show ${hidden} more`}
            </button>
          )}
          {unlisted > 0 && <span className="tabular">{unlisted} more not listed</span>}
        </div>
      )}
    </div>
  );
}

function FileRow({ file }: { file: GitFileChange }) {
  const { mark, className } = FILE_MARK[file.status];
  const { dir, name } = splitPath(file.path);
  const staged = file.staged && !file.unstaged;
  const title = [
    file.origPath ? `${file.origPath} → ${file.path}` : file.path,
    file.staged ? (file.unstaged ? 'partly staged' : 'staged') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex min-w-0 items-center gap-2" title={title}>
      <span aria-hidden className={cx('w-3 shrink-0 text-center', className)}>
        {mark}
      </span>
      <span className="sr-only">{file.status}: </span>
      <span className="flex min-w-0 flex-1 items-baseline">
        <span className="min-w-0 truncate text-text-1">{name}</span>
        {dir && <span className="ml-1.5 min-w-0 shrink-[100] truncate text-text-3">{dir}</span>}
      </span>
      {file.staged && (
        <span
          className={cx('shrink-0 text-meta', staged ? 'text-st-ok-ink' : 'text-text-3')}
          title={staged ? 'Staged' : 'Partly staged'}
        >
          <span aria-hidden>●</span>
          <span className="sr-only">{staged ? 'staged' : 'partly staged'}</span>
        </span>
      )}
    </li>
  );
}

function Commits({ commits, now }: { commits: readonly GitCommit[]; now: number }) {
  return (
    <div>
      <h3 className="mb-1.5 text-label text-text-2">Recent commits</h3>
      <ol className="flex flex-col gap-2">
        {commits.map((commit) => (
          <li key={commit.hash} className="flex min-w-0 flex-col gap-0.5" data-commit={commit.hash}>
            <span className="truncate text-body-sm text-text-1" title={commit.subject}>
              {commit.subject}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-meta text-text-2">
              <span className="shrink-0 font-mono">{commit.hash.slice(0, 7)}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{commit.author}</span>
              <span aria-hidden>·</span>
              <time
                className="shrink-0 tabular"
                dateTime={new Date(commit.at).toISOString()}
                title={formatDateTime(commit.at)}
              >
                {formatWhen(commit.at, now)}
              </time>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

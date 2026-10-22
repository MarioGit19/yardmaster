import type { Project } from '@c-board/protocol';
import { GitBranch, SquareTerminal } from 'lucide-react';
import { Link } from 'wouter';
import { selectSessionsByProject, selectTerminalsByProject, useBoardList } from '../data/index.js';
import { projectHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { formatCount, projectTone, sessionStatusView, totalTokens } from '../status.js';
import { Chip } from '../ui/Chip.js';
import { cx } from '../ui/cx.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StatusDot } from '../ui/StatusDot.js';

const BORDER = {
  wait: 'glow-st-wait',
  err: 'glow-st-err',
  work: 'border-st-work/40',
  tool: 'border-st-work/40',
  ok: '',
  idle: '',
} as const;

/** Interim overview card; the full ProjectPod arrives with 7.4. */
export function ProjectCard({ project }: { project: Project }) {
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const terminals = useBoardList(selectTerminalsByProject(project.id));
  const openTerminals = terminals.filter((t) => t.state === 'open');
  const tone = projectTone(sessions, terminals);
  const live = sessions.filter((s) => s.status.kind !== 'ended');

  return (
    <Link
      href={projectHref(project.id)}
      style={{ '--accent': `var(--accent-${project.accent})` } as React.CSSProperties}
      className={cx(
        'group relative flex min-w-0 flex-col gap-4 overflow-hidden rounded-panel border border-line bg-bg-1 p-4 shadow-raised',
        'transition-colors duration-150 ease-out hover:border-line-strong',
        'before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-[var(--accent)] before:opacity-70',
        BORDER[tone],
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <ProjectAvatar project={project} />
        <span className="min-w-0 flex-1 truncate font-medium text-title-sm text-text-1">
          {project.name}
        </span>
        {project.git?.branch && (
          <span className="hidden min-w-0 max-w-[45%] sm:flex">
            <Chip mono icon={<GitBranch />} title={project.git.branch}>
              {project.git.branch}
            </Chip>
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {live.length === 0 && <li className="text-body-sm text-text-3">No Claude sessions</li>}
        {live.slice(0, 3).map((session) => {
          const status = sessionStatusView(session.status);
          return (
            <li key={session.id} className="flex min-w-0 items-center gap-3 text-body-sm">
              <StatusDot
                tone={status.tone}
                label={status.label}
                showLabel
                className="min-w-0 flex-1 text-text-2"
              />
              <span className="tabular shrink-0 font-mono text-meta text-text-3">
                {formatCount(totalTokens(session))} tok
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex items-center gap-2 text-meta text-text-3">
        <SquareTerminal className="size-3.5" strokeWidth={1.5} aria-hidden />
        <span className="tabular">
          {openTerminals.length} {openTerminals.length === 1 ? 'terminal' : 'terminals'}
        </span>
        <span className="min-w-0 flex-1 truncate text-right font-mono" title={project.path}>
          {project.path}
        </span>
      </div>
    </Link>
  );
}

/** Pod-shaped loading placeholder. */
export function ProjectCardSkeleton() {
  return (
    <div
      aria-hidden
      className="flex flex-col gap-4 rounded-panel border border-line bg-bg-1 p-4 shadow-raised"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ml-auto h-5 w-24" />
      </div>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="mt-2 h-3 w-full" />
    </div>
  );
}

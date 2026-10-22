import type { ClaudeSession, Project } from '@c-board/protocol';
import { ArrowLeft, GitBranch, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import {
  selectHydrated,
  selectProject,
  selectSession,
  selectSessionsByProject,
  selectTerminalsByProject,
  useBoard,
  useBoardList,
} from '../data/index.js';
import { routes, sessionHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { formatCount, sessionStatusView, totalTokens } from '../status.js';
import { buttonClass } from '../ui/Button.js';
import { Chip } from '../ui/Chip.js';
import { cx } from '../ui/cx.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StatusDot } from '../ui/StatusDot.js';
import { EmptyState, Page } from './Page.js';

/** Interim focus view (`/p/:projectId[/s/:sessionId]`); the full layout arrives in phase 8. */
export function FocusView({ projectId, sessionId }: { projectId: string; sessionId?: string }) {
  const hydrated = useBoard(selectHydrated);
  const project = useBoard(selectProject(projectId));

  if (!project) {
    return (
      <Page>
        {hydrated ? (
          <EmptyState title="Project not found">
            It may have been closed.{' '}
            <Link href={routes.overview} className="text-text-1 underline underline-offset-2">
              Back to the overview
            </Link>
          </EmptyState>
        ) : (
          <FocusSkeleton />
        )}
      </Page>
    );
  }
  return <ProjectFocus project={project} sessionId={sessionId} />;
}

function ProjectFocus({ project, sessionId }: { project: Project; sessionId?: string }) {
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const terminals = useBoardList(selectTerminalsByProject(project.id));
  const selected = useBoard(selectSession(sessionId ?? ''));
  const session = selected?.projectId === project.id ? selected : undefined;
  const git = project.git;

  return (
    <Page>
      <header className="mb-6 flex min-w-0 items-center gap-3">
        <Link
          href={routes.overview}
          aria-label="Back to the overview"
          className={buttonClass('ghost', 'sm', { square: true })}
        >
          <ArrowLeft className="size-4" strokeWidth={1.5} />
        </Link>
        <ProjectAvatar project={project} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate font-medium text-title text-text-1">{project.name}</h1>
          <p className="truncate font-mono text-meta text-text-3" title={project.path}>
            {project.path}
          </p>
        </div>
        {git?.branch && (
          <span className="hidden min-w-0 max-w-60 sm:flex">
            <Chip mono icon={<GitBranch />} title={git.branch}>
              {git.branch}
              {git.dirty > 0 && ` · ${git.dirty} changed`}
              {git.ahead > 0 && ` · ↑${git.ahead}`}
            </Chip>
          </span>
        )}
      </header>

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        <Panel title="Sessions">
          {sessions.length === 0 ? (
            <p className="text-body-sm text-text-3">No Claude sessions</p>
          ) : (
            <ul className="-mx-2 flex flex-col gap-0.5">
              {sessions.map((s) => (
                <li key={s.id}>
                  <SessionLink session={s} projectId={project.id} active={s.id === session?.id} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={session ? (session.title ?? 'Claude session') : 'Claude'}>
          {session ? (
            <SessionSummary session={session} />
          ) : sessionId ? (
            <p className="text-body-sm text-text-3">This session is no longer available.</p>
          ) : (
            <p className="text-body-sm text-text-3">Pick a session to see its details.</p>
          )}
        </Panel>

        <Panel title="Terminals">
          {terminals.length === 0 ? (
            <p className="text-body-sm text-text-3">No terminals</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {terminals.map((t) => (
                <li key={t.id} className="flex min-w-0 items-center gap-2 text-body-sm">
                  <SquareTerminal
                    className="size-4 shrink-0 text-text-3"
                    strokeWidth={1.5}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-text-2" title={t.name}>
                    {t.name}
                  </span>
                  {t.state === 'closed' && (
                    <StatusDot
                      tone={t.exitCode ? 'err' : 'idle'}
                      label={t.exitCode ? `Exited ${t.exitCode}` : 'Closed'}
                      showLabel
                      className="text-meta text-text-3"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Page>
  );
}

function SessionLink({
  session,
  projectId,
  active,
}: {
  session: ClaudeSession;
  projectId: string;
  active: boolean;
}) {
  const status = sessionStatusView(session.status);
  return (
    <Link
      href={sessionHref(projectId, session.id)}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex min-w-0 flex-col gap-0.5 rounded-control px-2 py-1.5 transition-colors duration-150',
        active ? 'bg-bg-2 shadow-raised' : 'hover:bg-bg-2/60',
      )}
    >
      <span className="truncate text-body-sm text-text-1">{session.title ?? 'Claude session'}</span>
      <StatusDot
        tone={status.tone}
        label={status.label}
        showLabel
        className="text-meta text-text-3"
      />
    </Link>
  );
}

function SessionSummary({ session }: { session: ClaudeSession }) {
  const status = sessionStatusView(session.status);
  const rows: [string, ReactNode][] = [
    ['Status', <StatusDot key="s" tone={status.tone} label={status.label} showLabel />],
    ['Model', session.model ?? '—'],
    [
      'Tokens',
      <span key="t" className="tabular font-mono">
        {formatCount(totalTokens(session))}
      </span>,
    ],
    ['Current tool', session.currentTool?.summary ?? session.currentTool?.tool ?? '—'],
  ];
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-body-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-text-3">{term}</dt>
            <dd className="truncate text-text-1">{value}</dd>
          </div>
        ))}
      </dl>
      {session.lastAssistantText && (
        <p className="line-clamp-4 border-line border-t pt-4 text-body text-text-2">
          {session.lastAssistantText}
        </p>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-panel border border-line bg-bg-1 p-5 shadow-raised">
      <h2 className="truncate font-medium text-body text-text-1">{title}</h2>
      {children}
    </section>
  );
}

function FocusSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-48 rounded-panel" />
        ))}
      </div>
    </div>
  );
}

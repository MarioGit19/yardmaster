import type { ClaudeSession, GitFileStatus, Project } from '@c-board/protocol';
import { ArrowDown, ArrowLeft, ArrowUp, GitBranch, GitCommitHorizontal } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ClaudePanel } from '../claude/ClaudePanel.js';
import {
  selectApproval,
  selectHydrated,
  selectProject,
  selectSession,
  selectSessionsByProject,
  selectTerminalsByProject,
  useBoard,
  useBoardList,
} from '../data/index.js';
import { dur, ease, spring } from '../motion.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { orbStateFor } from '../orb/model.js';
import { podSessions } from '../pod/model.js';
import { useMediaQuery } from '../prefs.js';
import { routes, sessionHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { formatCount, sessionStatusView, totalTokens } from '../status.js';
import { TerminalStack } from '../terminal/TerminalStack.js';
import { buttonClass } from '../ui/Button.js';
import { Chip } from '../ui/Chip.js';
import { cx } from '../ui/cx.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import { EmptyState } from '../views/Page.js';
import { ResizableColumns } from './ResizableColumns.js';
import { sharedId } from './shared.js';

/** Below this width the three columns become tabs. */
export const FOCUS_TABS_QUERY = '(max-width: 1023px)';

const LABELS = { left: 'Sessions and git', center: 'Claude', right: 'Terminals' } as const;

export interface FocusViewProps {
  projectId: string;
  sessionId?: string;
  /** Morph out of (and back into) the project's pod. Off for a direct load of the route. */
  shared: boolean;
}

/** The project focus view, DESIGN.md §4.6, as a card over the dimmed overview. */
export function FocusView({ projectId, sessionId, shared }: FocusViewProps) {
  const hydrated = useBoard(selectHydrated);
  const project = useBoard(selectProject(projectId));

  if (!project) {
    return (
      <div className="focus-card flex h-full items-center justify-center rounded-panel border border-line bg-bg-1 shadow-raised">
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
      </div>
    );
  }
  return <ProjectFocus project={project} sessionId={sessionId} shared={shared} />;
}

/** The body fades in once the card has mostly grown, and out first on the way back. */
const body = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: dur.base, ease: ease.out, delay: 0.1 } },
  exit: { opacity: 0, transition: { duration: dur.fast, ease: ease.out } },
};

function ProjectFocus({
  project,
  sessionId,
  shared,
}: {
  project: Project;
  sessionId?: string;
  shared: boolean;
}) {
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const terminals = useBoardList(selectTerminalsByProject(project.id));
  const selected = useBoard(selectSession(sessionId ?? ''));
  const live = podSessions(sessions);
  // Without a session in the route, the Claude panel shows the project's most relevant one.
  const session = selected?.projectId === project.id ? selected : sessionId ? undefined : live[0];
  const accent = `var(--accent-${project.accent})`;
  const tabs = useMediaQuery(FOCUS_TABS_QUERY);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Keyboard and screen-reader users land in the view they just opened.
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const sessionsColumn = (
    <SessionsColumn
      project={project}
      sessions={sessions}
      activeId={session?.id}
      accent={accent}
      sharedOrbs={shared && !tabs}
    />
  );
  const claudeColumn = (
    <ClaudeColumn session={session} missing={Boolean(sessionId && !session)} defer={shared} />
  );
  const [maximized, setMaximized] = useState(false);
  const terminalsColumn = (
    <TerminalStack
      projectId={project.id}
      terminals={terminals}
      deferRenderers={shared}
      {...(tabs ? {} : { maximized, onMaximizedChange: setMaximized })}
    />
  );

  return (
    <motion.div
      layoutId={shared ? sharedId.container(project.id) : undefined}
      transition={spring.smooth}
      data-focus={project.id}
      style={{ borderRadius: 16, '--accent': accent } as never}
      className="focus-card relative flex h-full min-h-0 flex-col overflow-hidden border border-line bg-bg-1 shadow-raised"
    >
      <motion.header
        layoutId={shared ? sharedId.header(project.id) : undefined}
        transition={spring.smooth}
        className="flex min-w-0 shrink-0 items-center gap-3 border-line border-b px-4 py-3 md:px-5"
      >
        <Tooltip content="Back to the overview" shortcut="Esc">
          <Link
            href={routes.overview}
            aria-label="Back to the overview"
            className={buttonClass('ghost', 'sm', { square: true })}
          >
            <ArrowLeft className="size-4" strokeWidth={1.5} />
          </Link>
        </Tooltip>
        <ProjectAvatar project={project} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1
            ref={headingRef}
            tabIndex={-1}
            title={project.name}
            className="truncate font-medium text-title text-text-1 outline-none focus-visible:shadow-none"
          >
            {project.name}
          </h1>
          <p className="truncate font-mono text-meta text-text-3" title={project.path}>
            {project.path}
          </p>
        </div>
        {project.git?.branch && (
          <span className="hidden min-w-0 max-w-60 sm:flex">
            <Chip mono icon={<GitBranch />} title={project.git.branch}>
              {project.git.branch}
            </Chip>
          </span>
        )}
      </motion.header>

      <motion.div {...body} className="flex min-h-0 flex-1 flex-col">
        {tabs ? (
          <FocusTabs
            panels={[
              { id: 'sessions', label: 'Sessions', content: sessionsColumn },
              { id: 'claude', label: 'Claude', content: claudeColumn },
              { id: 'terminals', label: 'Terminals', content: terminalsColumn },
            ]}
          />
        ) : (
          <ResizableColumns
            projectId={project.id}
            labels={LABELS}
            left={sessionsColumn}
            center={claudeColumn}
            right={terminalsColumn}
            rightMaximized={maximized}
          />
        )}
      </motion.div>
    </motion.div>
  );
}

interface TabPanel {
  id: string;
  label: string;
  content: ReactNode;
}

/** Narrow screens: one column at a time, Claude first. */
function FocusTabs({ panels }: { panels: TabPanel[] }) {
  const [active, setActive] = useState('claude');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    panels.findIndex((p) => p.id === active),
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + panels.length) % panels.length;
    setActive(panels[next]?.id ?? active);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="Focus view panels"
        onKeyDown={onKeyDown}
        className="flex shrink-0 gap-1 border-line border-b px-3"
      >
        {panels.map((panel, i) => {
          const selected = panel.id === active;
          return (
            <button
              key={panel.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`focus-tab-${panel.id}`}
              aria-selected={selected}
              aria-controls={`focus-panel-${panel.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(panel.id)}
              className={cx(
                'relative h-10 rounded-control px-3 text-body-sm transition-colors duration-150',
                selected ? 'text-text-1' : 'text-text-3 hover:text-text-2',
              )}
            >
              {panel.label}
              {selected && (
                <motion.span
                  layoutId="focus-tab-indicator"
                  transition={spring.snappy}
                  aria-hidden
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-text-1"
                />
              )}
            </button>
          );
        })}
      </div>
      {panels.map((panel) => (
        <div
          key={panel.id}
          role="tabpanel"
          id={`focus-panel-${panel.id}`}
          aria-labelledby={`focus-tab-${panel.id}`}
          hidden={panel.id !== active}
          className="focus-col min-h-0 flex-1"
        >
          {panel.content}
        </div>
      ))}
    </>
  );
}

function ColumnHeading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <h2 className="mb-3 flex min-w-0 items-baseline gap-2 font-medium text-body text-text-1">
      <span className="truncate">{children}</span>
      {meta !== undefined && <span className="tabular text-meta text-text-3">{meta}</span>}
    </h2>
  );
}

function SessionsColumn({
  project,
  sessions,
  activeId,
  accent,
  sharedOrbs,
}: {
  project: Project;
  sessions: readonly ClaudeSession[];
  activeId: string | undefined;
  accent: string;
  /** Orbs take part in the hand-off only where the session list is on screen (not in tabs). */
  sharedOrbs: boolean;
}) {
  const live = podSessions(sessions);
  const ended = sessions.filter((s) => s.status.kind === 'ended');
  const ordered = [...live, ...ended];
  return (
    <div className="flex flex-col gap-6">
      <div>
        <ColumnHeading meta={sessions.length || undefined}>Sessions</ColumnHeading>
        {ordered.length === 0 ? (
          <p className="text-body-sm text-text-3">No Claude sessions</p>
        ) : (
          <ul className="-mx-2 flex flex-col gap-0.5">
            {ordered.map((s) => (
              <li key={s.id}>
                <SessionLink
                  session={s}
                  projectId={project.id}
                  active={s.id === activeId}
                  accent={accent}
                  shared={sharedOrbs}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <GitSummary git={project.git} />
    </div>
  );
}

function SessionLink({
  session,
  projectId,
  active,
  accent,
  shared,
}: {
  session: ClaudeSession;
  projectId: string;
  active: boolean;
  accent: string;
  shared: boolean;
}) {
  const status = sessionStatusView(session.status);
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const countdown =
    approval?.state === 'pending' && approval.expiresAt !== null
      ? { startedAt: approval.createdAt, endsAt: approval.expiresAt }
      : null;
  return (
    <Link
      href={sessionHref(projectId, session.id)}
      aria-current={active ? 'page' : undefined}
      data-session={session.id}
      className={cx(
        'flex min-w-0 items-center gap-3 rounded-control px-2 py-1.5 transition-colors duration-150',
        active ? 'bg-bg-2 shadow-raised' : 'hover:bg-bg-2/60',
      )}
    >
      <motion.span
        layoutId={shared ? sharedId.orb(session.id) : undefined}
        transition={spring.smooth}
        className="flex shrink-0"
      >
        <ClaudeOrb
          state={orbStateFor(session.status)}
          size={28}
          accent={accent}
          tool={session.status.kind === 'tool' ? session.status.tool : null}
          subagents={session.subagents.filter((a) => a.status === 'running').length}
          countdown={countdown}
          showToolLabel={false}
        />
      </motion.span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body-sm text-text-1" title={session.title ?? undefined}>
          {session.title ?? 'Claude session'}
        </span>
        <span className="flex min-w-0 items-center justify-between gap-2">
          <StatusDot
            tone={status.tone}
            label={status.label}
            showLabel
            className="min-w-0 text-meta text-text-3"
          />
          <span className="tabular shrink-0 font-mono text-meta text-text-3">
            {formatCount(totalTokens(session))} tok
          </span>
        </span>
      </span>
    </Link>
  );
}

const FILE_MARK: Record<GitFileStatus, { mark: string; className: string }> = {
  modified: { mark: 'M', className: 'text-st-work' },
  added: { mark: 'A', className: 'text-st-ok' },
  deleted: { mark: 'D', className: 'text-st-err' },
  renamed: { mark: 'R', className: 'text-st-work' },
  copied: { mark: 'C', className: 'text-st-work' },
  typechange: { mark: 'T', className: 'text-st-work' },
  untracked: { mark: 'U', className: 'text-text-3' },
  conflicted: { mark: '!', className: 'text-st-err' },
};

/** Interim git summary; 7.12 replaces it with the full `GitPanel`. */
const MAX_FILES = 8;

function GitSummary({ git }: { git: Project['git'] }) {
  if (!git) {
    return (
      <div>
        <ColumnHeading>Git</ColumnHeading>
        <p className="text-body-sm text-text-3">Not a git repository</p>
      </div>
    );
  }
  const branch = git.branch ?? (git.head ? git.head.slice(0, 7) : 'no branch');
  const last = git.commits[0];
  const hidden = git.dirty - Math.min(git.files.length, MAX_FILES);
  return (
    <div className="flex flex-col gap-3">
      <ColumnHeading meta={git.dirty ? `${git.dirty} changed` : undefined}>Git</ColumnHeading>
      <p className="-mt-2 flex min-w-0 items-center gap-2.5 font-mono text-meta text-text-3 tabular">
        <span className="flex min-w-0 items-center gap-1" title={branch}>
          <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
          <span className="truncate text-text-2">{branch}</span>
        </span>
        {git.ahead > 0 && (
          <span className="flex shrink-0 items-center" title={`${git.ahead} ahead`}>
            <ArrowUp aria-hidden className="size-3" strokeWidth={1.75} />
            {git.ahead}
          </span>
        )}
        {git.behind > 0 && (
          <span className="flex shrink-0 items-center" title={`${git.behind} behind`}>
            <ArrowDown aria-hidden className="size-3" strokeWidth={1.75} />
            {git.behind}
          </span>
        )}
      </p>
      {git.files.length > 0 && (
        <ul className="flex flex-col gap-1 font-mono text-label">
          {git.files.slice(0, MAX_FILES).map((file) => {
            const { mark, className } = FILE_MARK[file.status];
            return (
              <li key={file.path} className="flex min-w-0 items-center gap-2" title={file.path}>
                <span aria-hidden className={cx('w-3 shrink-0 text-center', className)}>
                  {mark}
                </span>
                <span className="sr-only">{file.status}: </span>
                <span className="truncate text-text-2">{file.path}</span>
              </li>
            );
          })}
          {hidden > 0 && <li className="pl-5 text-meta text-text-3 tabular">{hidden} more</li>}
        </ul>
      )}
      {last && (
        <p className="flex min-w-0 items-center gap-2 text-label text-text-3" title={last.subject}>
          <GitCommitHorizontal aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="shrink-0 font-mono">{last.hash.slice(0, 7)}</span>
          <span className="truncate text-text-2">{last.subject}</span>
        </p>
      )}
    </div>
  );
}

function ClaudeColumn({
  session,
  missing,
  defer,
}: {
  session?: ClaudeSession;
  missing: boolean;
  defer: boolean;
}) {
  if (!session) {
    return (
      <>
        <ColumnHeading>Claude</ColumnHeading>
        <p className="text-body-sm text-text-3">
          {missing ? 'This session is no longer available.' : 'No Claude sessions in this project.'}
        </p>
      </>
    );
  }
  return <ClaudePanel session={session} defer={defer} />;
}

function FocusSkeleton() {
  return (
    <div aria-busy className="flex h-full w-full flex-col gap-6 p-5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      </div>
      <div className="grid flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_420px]">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-48 rounded-panel" />
        ))}
      </div>
    </div>
  );
}

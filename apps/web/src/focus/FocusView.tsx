import {
  type ClaudeSession,
  type Project,
  sessionDisplayName,
  sessionSubtitle,
} from '@c-board/protocol';
import { ArrowLeft, GitBranch, Plus } from 'lucide-react';
import { AnimatePresence, type HTMLMotionProps, motion, type Transition } from 'motion/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useNow } from '../anim/clock.js';
import { ClaudePanel } from '../claude/ClaudePanel.js';
import { NewSessionComposer } from '../claude/Composer.js';
import { OriginBadge } from '../claude/OriginBadge.js';
import { CrewMascot } from '../crew/CrewMascot.js';
import { miniCrewCount } from '../crew/model.js';
import { useCrewTerminals } from '../crew/useCrewTerminals.js';
import {
  activityKey,
  selectApproval,
  selectHydrated,
  selectProject,
  selectSession,
  selectSessionsByProject,
  selectTerminalsByProject,
  useBoard,
  useBoardList,
} from '../data/index.js';
import { DraftMarker } from '../drafts/DraftMarker.js';
import { draftKey } from '../drafts/drafts.js';
import { GitPanel } from '../git/GitPanel.js';
import { SessionHistory } from '../history/SessionHistory.js';
import { dur, ease, slide, spring, tabGlide, useMotionLevel } from '../motion.js';
import { podSessions } from '../pod/model.js';
import { DoneSweep } from '../pod/PodActivity.js';
import { type CrewView, SessionCrew } from '../pod/SessionCrew.js';
import { useMascotState } from '../pod/useMascotState.js';
import { useMediaQuery } from '../prefs.js';
import { projectHref, routes, sessionHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { formatCount, sessionStatusView, totalTokens } from '../status.js';
import { useNewTerminalRequest } from '../terminal/newTerminal.js';
import { TerminalStack } from '../terminal/TerminalStack.js';
import { useTerminalTarget } from '../terminal/target.js';
import { buttonClass } from '../ui/Button.js';
import { Chip } from '../ui/Chip.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import { EmptyState } from '../views/Page.js';
import { ColumnHeading } from './ColumnHeading.js';
import { claudeColumnSession } from './claudeColumn.js';
import { FocusCaption } from './FocusCaption.js';
import { ResizableColumns } from './ResizableColumns.js';
import { sharedId } from './shared.js';

/** Below this width the three columns become tabs. */
export const FOCUS_TABS_QUERY = '(max-width: 1023px)';

const LABELS = { left: 'Sessions, history and git', center: 'Claude', right: 'Terminals' } as const;
/** The header's crew member: full acting with props in detail (DESIGN.md §4.11). */
const HEADER_CREW_PX = 120;
/** Sleeping crews only need to notice five quiet minutes. */
const IDLE_CLOCK_MS = 15_000;

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

/** The body fades out first on the way back; its columns settle in on their own. */
const body = { exit: { opacity: 0, transition: { duration: dur.fast, ease: ease.out } } };

/**
 * Each column settles once the card has mostly grown: opacity and a 4 px rise on `smooth`, all
 * together (no stagger). Reduced only fades. The transform is dropped at rest so a column never
 * keeps a containing block for its fixed and maximized layers.
 */
export function columnSettle(still: boolean, delay: number): HTMLMotionProps<'div'> {
  return {
    initial: { opacity: 0, transform: slide(still, '4px') },
    animate: {
      opacity: 1,
      transform: slide(still, '0px'),
      transition: {
        default: { ...spring.smooth, delay },
        opacity: { duration: dur.base, ease: ease.out, delay },
      },
      transitionEnd: { transform: 'none' },
    },
  };
}

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
  // A session the stack took over ("Show here instead") until a row puts it back here.
  const [released, setReleased] = useState<string | null>(null);
  useEffect(() => {
    if (sessionId) setReleased(null);
  }, [sessionId]);
  const session = claudeColumnSession({
    projectId: project.id,
    sessionId,
    selected,
    live,
    released,
  });
  const [, navigate] = useLocation();
  const showChatInStack = (id: string) => {
    setReleased(id);
    if (sessionId === id) navigate(projectHref(project.id));
  };
  const accent = `var(--accent-${project.accent})`;
  const tabs = useMediaQuery(FOCUS_TABS_QUERY);
  // A terminal picked in ⌘K, or a new one asked for there or in the pod's menu.
  const terminalTargeted = useTerminalTarget(project.id) !== null;
  const newTerminalRequested = useNewTerminalRequest(project.id);
  const terminalRequested = terminalTargeted || newTerminalRequested;
  // "New session" swaps the Claude panel for a blank composer until the session exists.
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (sessionId) setComposing(false);
  }, [sessionId]);
  const now = useNow(IDLE_CLOCK_MS);
  const crew = useCrewTerminals(terminals);
  const still = useMotionLevel() !== 'full';
  const settle = columnSettle(still, shared ? dur.base : 0);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Keyboard and screen-reader users land in the view they just opened.
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const sessionsColumn = (
    <SessionsColumn
      project={project}
      sessions={sessions}
      activeId={composing ? undefined : session?.id}
      accent={accent}
      crew={crew}
      now={now}
      sharedOrbs={shared && !tabs}
      composing={composing}
      onNewSession={() => setComposing(true)}
    />
  );
  const claudeColumn = (
    <ClaudeColumn
      project={project}
      session={composing ? undefined : session}
      missing={!composing && Boolean(sessionId && !session)}
      defer={shared}
    />
  );
  const [maximized, setMaximized] = useState(false);
  const terminalsColumn = (
    <TerminalStack
      projectId={project.id}
      terminals={terminals}
      deferRenderers={shared}
      // Beside the stack only when the Claude column is on screen next to it.
      besideSessionId={tabs || maximized || composing ? undefined : session?.id}
      onShowChatHere={showChatInStack}
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
        className="relative flex min-w-0 shrink-0 items-center gap-3 border-line border-b px-4 py-3 md:px-5"
      >
        {session && <DoneSweep key={session.id} pulseKey={activityKey.session(session.id)} />}
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
          <p className="truncate font-mono text-meta text-text-2" title={project.path}>
            {project.path}
          </p>
        </div>
        <HeaderCrew
          key={composing ? 'new' : (session?.id ?? 'project')}
          session={composing ? null : (session ?? null)}
          accent={accent}
          crew={crew}
          now={now}
        />
        {session && session.status.kind !== 'ended' && (
          <div className="hidden min-w-0 max-w-[32rem] flex-[1.4] md:block">
            <FocusCaption session={session} />
          </div>
        )}
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
            settle={settle}
            show={composing ? 'claude' : terminalRequested ? 'terminals' : null}
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
            settle={settle}
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
function FocusTabs({
  panels,
  show,
  settle,
}: {
  panels: TabPanel[];
  show: string | null;
  settle: HTMLMotionProps<'div'>;
}) {
  const [active, setActive] = useState(show ?? 'claude');
  const [byKeyboard, setByKeyboard] = useState(false);
  // A panel asked for from outside (a terminal picked in ⌘K).
  useEffect(() => {
    if (show) setActive(show);
  }, [show]);
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
    setByKeyboard(true);
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
              onClick={(e) => {
                // detail 0: Enter or Space, not a pointer.
                setByKeyboard(e.detail === 0);
                setActive(panel.id);
              }}
              className={cx(
                'relative h-10 rounded-control px-3 text-body-sm transition-colors duration-fast',
                selected ? 'text-text-1' : 'text-text-3 hover:text-text-2',
              )}
            >
              {panel.label}
              {selected && (
                <motion.span
                  layoutId="focus-tab-indicator"
                  transition={tabGlide(byKeyboard)}
                  aria-hidden
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-text-1"
                />
              )}
            </button>
          );
        })}
      </div>
      {panels.map((panel) => (
        <motion.div
          {...settle}
          key={panel.id}
          role="tabpanel"
          id={`focus-panel-${panel.id}`}
          aria-labelledby={`focus-tab-${panel.id}`}
          hidden={panel.id !== active}
          className="focus-col min-h-0 flex-1"
        >
          {panel.content}
        </motion.div>
      ))}
    </>
  );
}

function SessionsColumn({
  project,
  sessions,
  activeId,
  accent,
  crew,
  now,
  sharedOrbs,
  composing,
  onNewSession,
}: {
  project: Project;
  sessions: readonly ClaudeSession[];
  activeId: string | undefined;
  accent: string;
  crew: CrewView;
  now: number;
  /** Orbs take part in the hand-off only where the session list is on screen (not in tabs). */
  sharedOrbs: boolean;
  composing: boolean;
  onNewSession: () => void;
}) {
  const live = podSessions(sessions);
  const ended = sessions.filter((s) => s.status.kind === 'ended');
  const ordered = [...live, ...ended];
  const knownIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  // Rows only measure when the list itself changes, not on every status tick.
  const orderKey = ordered.map((s) => s.id).join('|');
  // The highlight pill glides to a clicked row and snaps for keyboard picks (§3 rule 11).
  const [byKeyboard, setByKeyboard] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <ColumnHeading
          meta={sessions.length || undefined}
          actions={
            <IconButton
              label="New session"
              icon={<Plus className="size-4" strokeWidth={1.5} />}
              size="sm"
              aria-pressed={composing}
              onClick={onNewSession}
              data-new-session
            />
          }
        >
          Sessions
        </ColumnHeading>
        {ordered.length === 0 ? (
          <p className="text-body-sm text-text-2">No Claude sessions</p>
        ) : (
          <ul className="-mx-2 flex flex-col gap-0.5">
            <AnimatePresence initial={false}>
              {ordered.map((s) => (
                <motion.li
                  key={s.id}
                  layout="position"
                  layoutDependency={orderKey}
                  // y (not a transform string) composes with the layout glide.
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                  transition={spring.smooth}
                >
                  <SessionLink
                    session={s}
                    projectId={project.id}
                    active={s.id === activeId}
                    accent={accent}
                    crew={crew}
                    now={now}
                    shared={sharedOrbs}
                    pillGlide={byKeyboard ? tabGlide(true) : spring.smooth}
                    onPick={setByKeyboard}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
      <SessionHistory
        projectId={project.id}
        knownIds={knownIds}
        refreshKey={ended.length}
        branch={project.git?.branch ?? null}
      />
      <GitPanel git={project.git} now={Date.now()} />
    </div>
  );
}

function SessionLink({
  session,
  projectId,
  active,
  accent,
  crew,
  now,
  shared,
  pillGlide,
  onPick,
}: {
  session: ClaudeSession;
  projectId: string;
  active: boolean;
  accent: string;
  crew: CrewView;
  now: number;
  shared: boolean;
  pillGlide: Transition;
  /** Called on click with whether the keyboard picked the row. */
  onPick: (byKeyboard: boolean) => void;
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
      onClick={(e) => onPick(e.detail === 0)}
      className={cx(
        'relative isolate flex min-w-0 items-center gap-3 rounded-control px-2 py-1.5 transition-colors duration-fast',
        !active && 'hover:bg-bg-2/60',
      )}
    >
      {active && (
        // One highlight that slides from row to row as the session changes.
        <motion.span
          layoutId={`focus-session-pill:${projectId}`}
          transition={pillGlide}
          aria-hidden
          data-session-pill
          className="absolute inset-0 -z-10 rounded-control bg-bg-2 shadow-raised"
        />
      )}
      <motion.span
        layoutId={shared ? sharedId.orb(session.id) : undefined}
        transition={spring.smooth}
        className="flex w-7 shrink-0 justify-center"
      >
        <SessionCrew
          session={session}
          accent={accent}
          crew={crew}
          now={now}
          countdown={countdown}
        />
      </motion.span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            data-session-name
            className="min-w-0 flex-1 truncate text-body-sm text-text-1"
            title={sessionSubtitle(session) ?? undefined}
          >
            {sessionDisplayName(session)}
          </span>
          <DraftMarker draft={draftKey.session(session.id)} />
          {session.origin === 'board' && <OriginBadge origin="board" compact />}
        </span>
        <span className="flex min-w-0 items-center justify-between gap-2">
          <StatusDot
            tone={status.tone}
            label={status.label}
            showLabel
            className="min-w-0 text-meta text-text-2"
          />
          <span className="tabular shrink-0 font-mono text-meta text-text-2">
            {formatCount(totalTokens(session))} tok
          </span>
        </span>
      </span>
    </Link>
  );
}

/**
 * The focused session's crew member at full size (DESIGN.md §4.11), acting out the turn with its
 * props and playing the done sparkle when it finishes. The project's own crew while composing.
 */
function HeaderCrew({
  session,
  accent,
  crew,
  now,
}: {
  session: ClaudeSession | null;
  accent: string;
  crew: CrewView;
  now: number;
}) {
  const state = useMascotState(session, crew.terminals, now);
  const subagents = session?.subagents.filter((a) => a.status === 'running').length ?? 0;
  // Mini crew members stand to the right at 46% size; keep room for them.
  const minis = miniCrewCount(state, subagents);
  const mini = HEADER_CREW_PX * 0.46;
  const room = minis > 0 ? mini + (minis - 1) * mini * 0.62 : 0;
  return (
    <span data-focus-crew className="-my-2 hidden shrink-0 md:flex" style={{ marginRight: room }}>
      <CrewMascot
        state={state}
        size={HEADER_CREW_PX}
        color={accent}
        tool={session?.status.kind === 'tool' ? session.status.tool : null}
        subagents={subagents}
        activity={crew.activity}
      />
    </span>
  );
}

function ClaudeColumn({
  project,
  session,
  missing,
  defer,
}: {
  project: Project;
  session?: ClaudeSession;
  missing: boolean;
  defer: boolean;
}) {
  if (!session) {
    return (
      <div className="claude-panel flex h-full min-h-0 flex-col" data-new-session-panel>
        <header className="flex min-w-0 shrink-0 items-center gap-3 border-line border-b px-5 pt-5 pb-3">
          <h2 className="min-w-0 flex-1 truncate font-medium text-body text-text-1 leading-7">
            New session
          </h2>
          <OriginBadge origin="board" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5">
          <EmptyState title={missing ? 'This session is no longer available' : 'Start a session'}>
            Claude runs headless from the board in {project.name}, with your own Claude Code login.
            Pick a model and how much it may do without asking.
          </EmptyState>
        </div>
        <NewSessionComposer projectId={project.id} />
      </div>
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

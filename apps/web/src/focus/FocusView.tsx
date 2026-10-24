import {
  type ClaudeSession,
  type Project,
  sessionDisplayName,
  sessionSubtitle,
} from '@c-board/protocol';
import { LoaderCircle, Play, Plus } from 'lucide-react';
import { AnimatePresence, type HTMLMotionProps, motion, type Transition } from 'motion/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useNow } from '../anim/clock.js';
import { BackgroundLine } from '../background/BackgroundLine.js';
import { useBackgroundRequests } from '../background/open.js';
import { ClaudePanel } from '../claude/ClaudePanel.js';
import { useResume } from '../claude/Composer.js';
import { OriginBadge } from '../claude/OriginBadge.js';
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
  useBoardStore,
} from '../data/index.js';
import { DraftMarker } from '../drafts/DraftMarker.js';
import { draftKey } from '../drafts/drafts.js';
import { GitPanel } from '../git/GitPanel.js';
import { SessionHistory } from '../history/SessionHistory.js';
import { markOpened } from '../library/useActive.js';
import { dur, ease, slide, spring, tabGlide, useMotionLevel } from '../motion.js';
import { podSessions } from '../pod/model.js';
import { type CrewView, SessionCrew } from '../pod/SessionCrew.js';
import { useMediaQuery, usePreference } from '../prefs.js';
import { phosphorPreference } from '../retro/phosphor.js';
import { projectHref, routes, sessionHref } from '../routes.js';
import { NARROW_QUERY } from '../shell/prefs.js';
import { formatCount, sessionStatusView, totalTokens } from '../status.js';
import { useNewTerminalRequest } from '../terminal/newTerminal.js';
import { TerminalStack } from '../terminal/TerminalStack.js';
import { terminalTarget, useTerminalTarget } from '../terminal/target.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import { Skeleton } from '../ui/Skeleton.js';
import { StatusDot } from '../ui/StatusDot.js';
import { EmptyState } from '../views/Page.js';
import { ColumnHeading } from './ColumnHeading.js';
import { claudeColumnSession } from './claudeColumn.js';
import { NewSessionPanel } from './NewSessionPanel.js';
import { PhoneWorkspace } from './phone/PhoneWorkspace.js';
import { ResizableColumns } from './ResizableColumns.js';
import { sharedId } from './shared.js';
import { SkinContext, useStatusWord } from './skins/registry.js';
import type { PanelFrameProps } from './skins/types.js';
import { type ActiveSkin, useWorkspaceSkin } from './skins/useWorkspaceSkin.js';

/** Below this width the three columns become tabs. */
export const FOCUS_TABS_QUERY = '(max-width: 1023px)';

const LABELS = { left: 'Sessions, history and git', center: 'Claude', right: 'Terminals' } as const;
type PanelId = 'sessions' | 'claude' | 'terminals';
/** Sleeping crews only need to notice five quiet minutes. */
const IDLE_CLOCK_MS = 15_000;

export interface FocusViewProps {
  projectId: string;
  sessionId?: string;
  /** Opens the terminal stack on this terminal (`/p/:projectId/t/:terminalId`). */
  terminalId?: string;
  /** A phone workspace page (git, history, ports, new); the columns ignore it. */
  page?: string;
  /** Morph out of (and back into) the project's pod. Off for a direct load of the route. */
  shared: boolean;
  /** Cross-fade in and out instead (opened from a layout without pods, or at Reduced). */
  fade?: boolean;
}

/** The project focus view, DESIGN.md §4.6, as a card over the dimmed overview. */
export function FocusView({
  projectId,
  sessionId,
  terminalId,
  page,
  shared,
  fade = false,
}: FocusViewProps) {
  const hydrated = useBoard(selectHydrated);
  const project = useBoard(selectProject(projectId));
  const known = project !== undefined;
  const store = useBoardStore();
  // Opened from the board: it's on the overview when the user comes back (F26), however long
  // they stayed. Unless they left by closing it (12.6e).
  useEffect(() => {
    if (!known) return;
    markOpened(projectId);
    return () => {
      if (store.getState().board.projects[projectId]?.closedAt == null) markOpened(projectId);
    };
  }, [known, projectId, store]);
  const skin = useWorkspaceSkin();

  if (!project || !skin) {
    return (
      <div className="focus-card flex h-full items-center justify-center rounded-panel border border-line bg-bg-1 shadow-raised">
        {hydrated && skin ? (
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
  return (
    <ProjectFocus
      skin={skin}
      project={project}
      sessionId={sessionId}
      terminalId={terminalId}
      page={page}
      shared={shared}
      fade={fade}
    />
  );
}

/** Opened from a layout without pods: the card cross-fades over the overview (§10.1). */
const cardFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: dur.base, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: dur.fast, ease: ease.out } },
};

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
  skin,
  project,
  sessionId,
  terminalId,
  page,
  shared,
  fade,
}: {
  skin: ActiveSkin;
  project: Project;
  sessionId?: string;
  terminalId?: string;
  page?: string;
  shared: boolean;
  fade: boolean;
}) {
  const { HeaderBand, PanelFrame, EntryTransition } = skin.skin;
  const phosphor = usePreference(phosphorPreference);
  // Phones: a full-bleed workspace organised as a project hub (DESIGN.md §11).
  const phone = useMediaQuery(NARROW_QUERY);
  // A terminal deep link asks the stack for that tab, like a terminal picked in ⌘K. The phone
  // workspace opens the terminal's own page from the route instead.
  useEffect(() => {
    if (terminalId && !phone) terminalTarget.set({ projectId: project.id, terminalId });
  }, [project.id, terminalId, phone]);
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
  // A row's background line opens the session's Background list, in the Claude tab.
  const backgroundAsked = useBackgroundRequests();
  // "New session" swaps the Claude panel for a blank composer until the session exists.
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (sessionId) setComposing(false);
  }, [sessionId]);
  const now = useNow(IDLE_CLOCK_MS);
  const crew = useCrewTerminals(terminals);
  const level = useMotionLevel();
  const still = level !== 'full';
  const settle = columnSettle(still, shared ? dur.base : 0);
  // The skin's own entry replaces the cross-fade when the view opens from its overview at Full;
  // decided once, so a skin switched to later doesn't play it.
  const [entering] = useState(() => fade && level === 'full' && EntryTransition !== null);
  const claudeSession = composing ? undefined : session;
  const claudeTone = claudeSession ? sessionStatusView(claudeSession.status).tone : undefined;
  const frames: Record<PanelId, Omit<PanelFrameProps, 'children'>> = {
    sessions: { title: 'Sessions', activity: [activityKey.project(project.id)] },
    claude: {
      title: 'Claude',
      activity: claudeSession ? [activityKey.session(claudeSession.id)] : [],
      tone: claudeTone === 'wait' || claudeTone === 'err' ? claudeTone : undefined,
    },
    terminals: { title: 'Terminals', activity: terminals.map((t) => activityKey.terminal(t.id)) },
  };
  const framed = (id: PanelId, content: ReactNode) =>
    PanelFrame ? <PanelFrame {...frames[id]}>{content}</PanelFrame> : content;

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
      {...(fade && (entering ? { exit: cardFade.exit } : cardFade))}
      data-focus={project.id}
      data-layout={skin.id}
      data-phosphor={skin.id === 'retro' ? phosphor : undefined}
      data-workspace={phone ? 'phone' : undefined}
      style={{ borderRadius: phone ? 0 : 16, '--accent': accent } as never}
      className={cx(
        'focus focus-card relative flex h-full min-h-0 flex-col overflow-hidden bg-bg-1',
        !phone && 'border border-line shadow-raised',
      )}
    >
      <SkinContext.Provider value={skin.id}>
        {phone ? (
          <PhoneWorkspace
            project={project}
            sessionId={sessionId}
            terminalId={terminalId}
            page={page}
            headingRef={headingRef}
            HubCrew={skin.skin.HubCrew}
          />
        ) : (
          <HeaderBand
            project={project}
            session={composing ? null : (session ?? null)}
            composing={composing}
            accent={accent}
            crew={crew}
            now={now}
            headingRef={headingRef}
            shared={shared}
          />
        )}

        {!phone && (
          <motion.div {...body} className="flex min-h-0 flex-1 flex-col">
            {tabs ? (
              <FocusTabs
                settle={settle}
                show={
                  composing
                    ? 'claude'
                    : terminalRequested
                      ? 'terminals'
                      : backgroundAsked
                        ? 'claude'
                        : null
                }
                showNonce={backgroundAsked}
                panels={[
                  {
                    id: 'sessions',
                    label: 'Sessions',
                    content: framed('sessions', sessionsColumn),
                  },
                  { id: 'claude', label: 'Claude', content: framed('claude', claudeColumn) },
                  {
                    id: 'terminals',
                    label: 'Terminals',
                    content: framed('terminals', terminalsColumn),
                  },
                ]}
              />
            ) : (
              <ResizableColumns
                projectId={project.id}
                labels={LABELS}
                left={framed('sessions', sessionsColumn)}
                center={framed('claude', claudeColumn)}
                right={framed('terminals', terminalsColumn)}
                rightMaximized={maximized}
                settle={settle}
              />
            )}
          </motion.div>
        )}
      </SkinContext.Provider>
      {entering && EntryTransition && <EntryTransition projectId={project.id} />}
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
  showNonce = 0,
  settle,
}: {
  panels: TabPanel[];
  show: string | null;
  /** Changes when the same panel is asked for again. */
  showNonce?: number;
  settle: HTMLMotionProps<'div'>;
}) {
  const [active, setActive] = useState(show ?? 'claude');
  const [byKeyboard, setByKeyboard] = useState(false);
  // A panel asked for from outside (a terminal picked in ⌘K).
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new nonce asks again for `show`.
  useEffect(() => {
    if (show) setActive(show);
  }, [show, showNonce]);
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
                'relative rounded-control px-3 text-body-sm transition-colors duration-fast',
                'h-10 touch:h-11',
                selected ? 'text-text-1' : 'text-text-3 hover:text-text-2',
              )}
            >
              {panel.label}
              {selected && (
                <motion.span
                  layoutId="focus-tab-indicator"
                  transition={tabGlide(byKeyboard)}
                  aria-hidden
                  data-tab-indicator
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-text-1"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
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
      </div>
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
          <ul data-session-list className="-mx-2 flex flex-col gap-0.5">
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
  const word = useStatusWord();
  const approvalId =
    session.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const countdown =
    approval?.state === 'pending' && approval.expiresAt !== null
      ? { startedAt: approval.createdAt, endsAt: approval.expiresAt }
      : null;
  const interrupted = session.status.kind === 'interrupted';
  return (
    <div className="relative">
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
        <span className={cx('flex min-w-0 flex-1 flex-col gap-0.5', interrupted && 'pr-9')}>
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
              label={word({ kind: 'session', status: session.status }, status.label)}
              showLabel
              className="min-w-0 text-meta text-text-2"
            />
            {/* An interrupted session's Resume button sits here, outside the link. */}
            {!interrupted && (
              <span className="tabular shrink-0 font-mono text-meta text-text-2">
                {formatCount(totalTokens(session))} tok
              </span>
            )}
          </span>
        </span>
      </Link>
      {interrupted && <RowResume session={session} />}
      {/* Outside the link: it is a control of its own. Indented to the row's text. */}
      <BackgroundLine session={session} className="mb-1 ml-12" />
    </div>
  );
}

/** Resumes a board session a restart interrupted, from its row; the panel offers it too. */
function RowResume({ session }: { session: ClaudeSession }) {
  const { resuming, resume } = useResume(session);
  return (
    <IconButton
      label={`Resume ${sessionDisplayName(session)}`}
      variant="secondary"
      size="sm"
      data-row-resume
      onClick={() => void resume()}
      disabled={resuming}
      aria-busy={resuming}
      className="absolute top-1/2 right-2 -translate-y-1/2"
      icon={
        resuming ? (
          <LoaderCircle aria-hidden className="hud-spin size-3.5" strokeWidth={1.5} />
        ) : (
          <Play aria-hidden className="size-3.5" strokeWidth={1.5} />
        )
      }
    />
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
  if (!session) return <NewSessionPanel project={project} missing={missing} />;
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

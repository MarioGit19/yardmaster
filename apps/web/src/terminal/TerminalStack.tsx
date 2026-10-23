import {
  CLAUDE_NAME,
  type ClaudeSession,
  type StreamId,
  sessionSubtitle,
  type Terminal,
  terminalDisplayName,
  type UiAction,
} from '@c-board/protocol';
import {
  AppWindow,
  ChevronDown,
  ChevronUp,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { attentionOpen } from '../attention/attention.js';
import { ClaudePanel } from '../claude/ClaudePanel.js';
import {
  selectApproval,
  selectProject,
  selectTerminalSession,
  selectWindow,
  useBoard,
  useBoardClient,
  useBoardShallow,
} from '../data/index.js';
import type { BoardStoreState } from '../data/store.js';
import { DraftMarker } from '../drafts/DraftMarker.js';
import { draftKey, useHasDraft } from '../drafts/drafts.js';
import { ColumnHeading } from '../focus/ColumnHeading.js';
import { MORPH_SETTLE_MS } from '../focus/shared.js';
import { laneView, selectLaneExecution, terminalDisplay } from '../lanes/lane.js';
import { dur, ease, slide, spring, tabGlide, useMotionLevel } from '../motion.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { orbStateFor } from '../orb/model.js';
import { LiveCaption } from '../pod/LiveCaption.js';
import { sessionCaption } from '../pod/model.js';
import { usePreference } from '../prefs.js';
import { reveal, useMasked, useRedactOn } from '../redact/reveal.js';
import { isTypingTarget } from '../shell/railNav.js';
import { buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { ExitBadge } from '../ui/ExitBadge.js';
import { IconButton } from '../ui/IconButton.js';
import { Kbd } from '../ui/Kbd.js';
import { StatusDot } from '../ui/StatusDot.js';
import { Tooltip } from '../ui/Tooltip.js';
import {
  type ClaudeTerminalView,
  claudeTerminalLabel,
  claudeTerminalView,
  useClaudeTerminalView,
} from './claudeTerminal.js';
import { NewTerminalPopover } from './NewTerminalPopover.js';
import { arrivedTerminal, newTerminalRequest, useNewTerminalRequest } from './newTerminal.js';
import {
  actionErrorText,
  gridTerminals,
  paneKind,
  resolveActive,
  type StackLayout,
  stackLayoutPreference,
  stackOrder,
  stepTab,
} from './stack.js';
import { terminalTarget, useTerminalTarget } from './target.js';
import type { XtermController } from './XtermView.js';

// xterm and its renderers load with the first focus view, not with the overview.
const XtermView = lazy(() => import('./XtermView.js'));

export interface TerminalStackProps {
  projectId: string;
  terminals: readonly Terminal[];
  /** The stack covers the whole focus view. Undefined where maximizing makes no sense. */
  maximized?: boolean;
  onMaximizedChange?: (maximized: boolean) => void;
  /** Hold the renderers back until the pod-to-focus morph has settled, so it keeps its frames. */
  deferRenderers?: boolean;
  /**
   * The session the Claude column shows beside the stack, if it is on screen. A Claude terminal
   * running it points there instead of showing the same chat twice.
   */
  besideSessionId?: string;
  /** "Show here instead": the Claude column lets the session go so the stack can show it. */
  onShowChatHere?: (sessionId: string) => void;
}

/** How long a new terminal may take to show up before the stack stops waiting to select it. */
const ARRIVAL_TIMEOUT_MS = 20_000;

/**
 * The focus view's terminal stack, DESIGN.md §4.6: every terminal of the project mirrored in
 * xterm, as tabs or a 2×2 grid, with a toolbar and a command line for the active one. Only
 * visible panes keep a renderer; hidden ones keep their output in the client's stream history.
 */
export function TerminalStack({
  projectId,
  terminals,
  maximized,
  onMaximizedChange,
  deferRenderers = false,
  besideSessionId,
  onShowChatHere,
}: TerminalStackProps) {
  const [renderersReady, setRenderersReady] = useState(!deferRenderers);
  useEffect(() => {
    if (renderersReady) return;
    const timer = setTimeout(() => setRenderersReady(true), MORPH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [renderersReady]);
  const ordered = useMemo(() => stackOrder(terminals), [terminals]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [byKeyboard, setByKeyboard] = useState(false);
  // A terminal picked in ⌘K opens here once.
  const target = useTerminalTarget(projectId);
  useEffect(() => {
    if (target === null || !ordered.some((t) => t.id === target)) return;
    setChosen(target);
    terminalTarget.set(null);
  }, [target, ordered]);
  const interactiveIds = useBoard(selectInteractiveIds(ordered));
  const interactive = useMemo(() => new Set(interactiveIds.split('\n')), [interactiveIds]);
  // Claude terminals: terminal id → its live session. Picking a tab only changes the stack; the
  // Claude column follows the route (a session row), never the stack.
  const links = useBoard(selectClaudeLinks(ordered));
  const sessionOf = useMemo(() => parseLinks(links), [links]);
  const select = (terminalId: string, viaKeyboard: boolean) => {
    setByKeyboard(viaKeyboard);
    setChosen(terminalId);
  };

  // New terminals: the popover (also opened from ⌘K and the pod's menu), then the new tab is
  // selected once the editor reports it; one started with `claude` shows its chat once linked.
  const [creating, setCreating] = useState(false);
  const requested = useNewTerminalRequest(projectId);
  useEffect(() => {
    if (!requested || !renderersReady) return;
    newTerminalRequest.set(null);
    setCreating(true);
  }, [requested, renderersReady]);
  const [awaiting, setAwaiting] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!awaiting) return;
    const arrived = arrivedTerminal(awaiting, terminals);
    if (arrived === null) {
      const timer = setTimeout(() => setAwaiting(null), ARRIVAL_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }
    setAwaiting(null);
    setByKeyboard(false);
    setChosen(arrived);
    // The popover left focus nowhere; unless something took it since, it lands on the new tab.
    if (document.activeElement === document.body || document.activeElement === null) {
      tabRefs.current.get(arrived)?.focus({ preventScroll: true });
    }
  }, [awaiting, terminals]);
  const onCreated = () => setAwaiting(new Set(terminals.map((t) => t.id)));
  const project = useBoard(selectProject(projectId));
  const accent = `var(--accent-${project?.accent ?? 0})`;
  const newTerminal = (trigger: React.ReactElement) => (
    <NewTerminalPopover
      projectId={projectId}
      projectName={project?.name ?? 'this project'}
      open={creating}
      onOpenChange={setCreating}
      onCreated={onCreated}
      trigger={trigger}
    />
  );

  // Claude terminals count as interactive here: without a choice (or a session in the route) the
  // stack opens on output it mirrors, not on the chat the Claude column already shows.
  const activeId = resolveActive(ordered, chosen, (id) => !interactive.has(id));
  const active = ordered.find((t) => t.id === activeId) ?? null;
  const layout = usePreference(stackLayoutPreference);
  const grid = layout === 'grid' && ordered.length > 1;
  const panes = grid ? gridTerminals(ordered, activeId) : active ? [active] : [];
  const controllers = useRef(new Map<string, XtermController>());
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  // The tab bar scrolls sideways: keep a newly active tab in it (a new terminal lands at the end).
  // Only the bar scrolls (`scrollIntoView` would scroll the clipped focus card too), and not on
  // mount, while the view may still be morphing in.
  const tabList = useRef<HTMLDivElement>(null);
  const shownTab = useRef(activeId);
  useEffect(() => {
    if (activeId === shownTab.current) return;
    shownTab.current = activeId;
    const list = tabList.current;
    const tab = activeId === null ? undefined : tabRefs.current.get(activeId);
    if (!list || !tab) return;
    const bar = list.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (box.left < bar.left) list.scrollLeft -= bar.left - box.left;
    else if (box.right > bar.right) list.scrollLeft += box.right - bar.right;
  }, [activeId]);
  const activeController = useCallback(
    () => (activeId === null ? null : (controllers.current.get(activeId) ?? null)),
    [activeId],
  );

  useRetainedStreams(ordered);

  useEffect(() => {
    if (!maximized || !onMaximizedChange) return;
    // Capture phase: Escape restores the stack before the focus view would close.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || attentionOpen.get() === 'open') return;
      event.preventDefault();
      onMaximizedChange(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [maximized, onMaximizedChange]);

  const onTabKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = stepTab(ordered, activeId, step);
    if (next === null) return;
    select(next, true);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <div data-terminal-stack={projectId} className="flex h-full min-h-0 flex-col gap-3">
      <ColumnHeading
        className=""
        meta={ordered.length > 0 ? ordered.length : undefined}
        actions={
          <>
            {ordered.length > 1 && <LayoutToggle layout={layout} />}
            {onMaximizedChange && (
              <IconButton
                size="sm"
                label={maximized ? 'Restore terminals' : 'Maximize terminals'}
                aria-pressed={maximized}
                icon={
                  maximized ? (
                    <Minimize2 className="size-4" strokeWidth={1.5} />
                  ) : (
                    <Maximize2 className="size-4" strokeWidth={1.5} />
                  )
                }
                onClick={() => onMaximizedChange(!maximized)}
              />
            )}
          </>
        }
      >
        Terminals
      </ColumnHeading>

      {ordered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-control border border-line border-dashed px-6 text-center">
          <p className="text-body-sm text-text-2">No terminals</p>
          <p className="text-meta text-text-2">Terminals opened in the editor show up here.</p>
          {newTerminal(
            <button
              type="button"
              data-new-terminal
              aria-expanded={creating}
              className={cx(buttonClass('secondary', 'sm'), 'mt-3')}
            >
              <Plus aria-hidden className="size-3.5" strokeWidth={1.5} />
              New terminal
            </button>,
          )}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 shrink-0 items-center gap-1">
            <div
              ref={tabList}
              role="tablist"
              aria-label="Terminals"
              onKeyDown={onTabKey}
              className="-ml-1 flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5 pl-1"
            >
              <AnimatePresence initial={false}>
                {ordered.map((terminal) => (
                  <StackTab
                    key={terminal.id}
                    terminal={terminal}
                    projectId={projectId}
                    accent={accent}
                    selected={terminal.id === activeId}
                    byKeyboard={byKeyboard}
                    tabRef={(el) => {
                      if (el) tabRefs.current.set(terminal.id, el);
                      else tabRefs.current.delete(terminal.id);
                    }}
                    onSelect={(viaKeyboard) => select(terminal.id, viaKeyboard)}
                  />
                ))}
              </AnimatePresence>
            </div>
            {newTerminal(
              <IconButton
                size="sm"
                label="New terminal"
                data-new-terminal
                aria-expanded={creating}
                className="-mt-0.5"
                icon={<Plus className="size-4" strokeWidth={1.5} />}
              />,
            )}
          </div>

          <div
            role="tabpanel"
            aria-label={active ? `Terminal ${active.name}` : 'Terminal'}
            className={cx(
              'grid min-h-0 flex-1 gap-2',
              panes.length > 2 && 'grid-cols-2 grid-rows-2',
              panes.length === 2 && 'grid-rows-2',
            )}
          >
            {panes.map((terminal, i) => (
              <Pane
                key={terminal.id}
                terminal={terminal}
                accent={accent}
                besideSessionId={besideSessionId}
                onShowChatHere={onShowChatHere}
                compactChat={!maximized}
                inGrid={grid}
                active={terminal.id === activeId}
                wide={panes.length === 3 && i === 2}
                renderer={renderersReady}
                onActivate={() => setChosen(terminal.id)}
                onController={(c) => {
                  if (c) controllers.current.set(terminal.id, c);
                  else controllers.current.delete(terminal.id);
                }}
              />
            ))}
          </div>

          {active && (
            <ActiveControls
              key={active.id}
              terminal={active}
              claude={sessionOf.has(active.id)}
              controller={activeController}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Keeps each terminal's stream open while the stack is mounted, so switching panes replays. */
function useRetainedStreams(terminals: readonly Terminal[]) {
  const client = useBoardClient();
  const key = terminals.map((t) => t.id).join('\n');
  useEffect(() => {
    if (key === '') return;
    const stops = key
      .split('\n')
      .map((id) => client.subscribeStream(`term:${id}` as StreamId, () => {}));
    return () => {
      for (const stop of stops) stop();
    };
  }, [client, key]);
}

/** The ids of terminals showing an interactive app's pane, as one string so it compares by value. */
const selectInteractiveIds =
  (terminals: readonly Terminal[]) =>
  (s: BoardStoreState): string =>
    terminals
      .filter((t) => {
        const execution = selectLaneExecution(t)(s);
        return paneKind(execution.id === null ? null : execution, t) === 'interactive';
      })
      .map((t) => t.id)
      .join('\n');

/** `terminalId sessionId` per Claude terminal, one per line, so it compares by value. */
const selectClaudeLinks =
  (terminals: readonly Terminal[]) =>
  (s: BoardStoreState): string =>
    terminals
      .map((t) => {
        const session = selectTerminalSession(t.id)(s);
        return session ? `${t.id} ${session.id}` : '';
      })
      .filter(Boolean)
      .join('\n');

function parseLinks(links: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of links.split('\n')) {
    const [terminalId, sessionId] = line.split(' ');
    if (terminalId && sessionId) map.set(terminalId, sessionId);
  }
  return map;
}

/** The terminal's newest execution, its live Claude session (10.9) and what it's called. */
function useTerminalView(terminal: Terminal) {
  const execution = useBoardShallow(selectLaneExecution(terminal));
  const session = useBoard(selectTerminalSession(terminal.id));
  const display = terminalDisplay(terminal, execution, session);
  return { execution, session, display, view: laneView(terminal, execution, display.name) };
}

function LayoutToggle({ layout }: { layout: StackLayout }) {
  const next: StackLayout = layout === 'grid' ? 'tabs' : 'grid';
  return (
    <IconButton
      size="sm"
      label={layout === 'grid' ? 'Show one terminal' : 'Show up to four terminals'}
      aria-pressed={layout === 'grid'}
      icon={
        layout === 'grid' ? (
          <Square className="size-4" strokeWidth={1.5} />
        ) : (
          <LayoutGrid className="size-4" strokeWidth={1.5} />
        )
      }
      onClick={() => stackLayoutPreference.set(next)}
    />
  );
}

function StackTab({
  terminal,
  projectId,
  accent,
  selected,
  byKeyboard,
  tabRef,
  onSelect,
}: {
  terminal: Terminal;
  projectId: string;
  accent: string;
  selected: boolean;
  /** The selection came from the keyboard: the indicator snaps instead of gliding. */
  byKeyboard: boolean;
  tabRef: (el: HTMLButtonElement | null) => void;
  onSelect: (byKeyboard: boolean) => void;
}) {
  const { view, session, display } = useTerminalView(terminal);
  const caption = useSessionCaption(session);
  const closed = terminal.state === 'closed';
  const title = display.name;
  const draft = session ? draftKey.session(session.id) : null;
  const drafted = useHasDraft(draft) ? ', unsent draft' : '';
  // The editor's own name (`zsh`, `claude`) stays in the tooltip when the board replaced it.
  const raw = display.raw ? ` (${display.raw})` : '';
  return (
    // New tabs enter with a fade and a 4 px rise (DESIGN.md §3 rule 1); `y` stays still at Reduced.
    <motion.button
      ref={tabRef}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={`${session && caption ? claudeTerminalLabel(title, caption.text) : view.label}${drafted}`}
      title={
        session && caption
          ? `${title}${raw}: ${caption.text}`
          : view.command && view.command !== title
            ? `${title}${raw}: ${view.command}`
            : `${title}${raw}`
      }
      tabIndex={selected ? 0 : -1}
      data-tab={terminal.id}
      data-terminal-name={terminal.name}
      data-claude-tab={session?.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0, transition: spring.smooth }}
      exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
      // detail 0: Enter or Space, not a pointer.
      onClick={(e) => onSelect(e.detail === 0)}
      className={cx(
        'relative flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-control px-3 text-label transition-colors duration-fast',
        selected ? 'text-text-1' : 'text-text-3 hover:text-text-2',
        closed && 'opacity-70',
      )}
    >
      {selected && (
        <motion.span
          layoutId={`terminal-tab-${projectId}`}
          transition={tabGlide(byKeyboard)}
          aria-hidden
          className="absolute inset-0 rounded-control border border-line bg-bg-2 shadow-raised"
        />
      )}
      <span aria-hidden className="relative flex size-3.5 shrink-0 items-center justify-center">
        {session ? (
          <ClaudeOrb
            state={orbStateFor(session.status)}
            size={14}
            accent={accent}
            tool={session.status.kind === 'tool' ? session.status.tool : null}
            showToolLabel={false}
          />
        ) : (
          <StatusDot tone={view.tone} label={view.label} />
        )}
      </span>
      <TabTitle text={title} />
      <DraftMarker draft={draft} className="relative" />
      <AnimatePresence initial={false}>
        {!session && view.exit && view.exit.code !== 0 && (
          <ExitBadge key={view.exit.key} code={view.exit.code} className="relative -mr-1" />
        )}
      </AnimatePresence>
    </motion.button>
  );
}

/** A tab's name; a new one (Claude's session title, or back to the process) slides in like a caption. */
function TabTitle({ text }: { text: string }) {
  const still = useMotionLevel() !== 'full';
  return (
    <span className="relative flex min-w-0 overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={text}
          initial={{ opacity: 0, transform: slide(still, '80%') }}
          animate={{ opacity: 1, transform: slide(still, '0%'), transition: spring.snappy }}
          exit={{
            opacity: 0,
            transform: slide(still, '-80%'),
            transition: { duration: dur.fast, ease: ease.out },
          }}
          className="block min-w-0 truncate"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function useSessionCaption(session: ClaudeSession | undefined) {
  const approvalId =
    session?.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  return session ? sessionCaption(session, approval) : null;
}

/** What a pane shows: Claude's chat, the mirrored output, or the pointer to an alt-screen app. */
type PaneContent = 'chat' | 'xterm' | 'interactive';

function Pane({
  terminal,
  accent,
  besideSessionId,
  onShowChatHere,
  compactChat,
  inGrid,
  active,
  wide,
  renderer,
  onActivate,
  onController,
}: {
  terminal: Terminal;
  accent: string;
  besideSessionId: string | undefined;
  onShowChatHere: ((sessionId: string) => void) | undefined;
  compactChat: boolean;
  inGrid: boolean;
  active: boolean;
  wide: boolean;
  renderer: boolean;
  onActivate: () => void;
  onController: (controller: XtermController | null) => void;
}) {
  const { execution, view, session, display } = useTerminalView(terminal);
  const kind = paneKind(execution.id === null ? null : execution, terminal);
  const masked = useMasked(`term:${terminal.id}`);
  const name = display.name;
  const chosenView = useClaudeTerminalView(terminal.id);
  // A Claude terminal shows its chat unless asked for the raw TUI; when the session ends it is a
  // plain terminal again, and the content cross-fades either way.
  const content: PaneContent = session ? (chosenView === 'chat' ? 'chat' : 'xterm') : kind;
  return (
    <section
      aria-label={session && !name.startsWith(CLAUDE_NAME) ? `${name}, ${CLAUDE_NAME}` : name}
      data-pane={terminal.id}
      data-pane-content={content}
      data-active={(inGrid && active) || undefined}
      onPointerDown={inGrid ? onActivate : undefined}
      onFocusCapture={inGrid ? onActivate : undefined}
      className={cx(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-control border bg-bg-0 transition-[border-color,box-shadow] duration-fast',
        inGrid && active ? 'border-line-strong shadow-raised' : 'border-line',
        wide && 'col-span-2',
      )}
    >
      {session ? (
        <ClaudePaneHeader
          terminal={terminal}
          name={name}
          session={session}
          accent={accent}
          view={chosenView}
          inGrid={inGrid}
          active={active}
        />
      ) : (
        inGrid && (
          <header className="flex h-7 shrink-0 items-center gap-1.5 border-line border-b px-3 text-label">
            <StatusDot tone={view.tone} label={view.label} />
            <span
              title={display.raw ? `${name} (${display.raw})` : name}
              className={cx(
                'max-w-[60%] shrink-0 truncate',
                active ? 'text-text-1' : 'text-text-2',
              )}
            >
              {name}
            </span>
            {view.command && view.command !== name && (
              <span
                className="min-w-0 truncate font-mono text-meta text-text-2"
                title={view.command}
              >
                {view.command}
              </span>
            )}
            <span className="ml-auto flex">
              <AnimatePresence initial={false}>
                {view.exit && <ExitBadge key={view.exit.key} code={view.exit.code} />}
              </AnimatePresence>
            </span>
          </header>
        )
      )}
      {/* One grid cell, so the outgoing content fades out under the incoming one (dur.base in,
          dur.fast out). */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
        <AnimatePresence initial={false}>
          <motion.div
            key={content}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: dur.base, ease: ease.out } }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
            className="col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col"
          >
            {content === 'chat' && session ? (
              session.id === besideSessionId ? (
                <ChatBeside
                  session={session}
                  accent={accent}
                  compact={inGrid}
                  onShowHere={onShowChatHere && (() => onShowChatHere(session.id))}
                />
              ) : (
                <ClaudePanel session={session} defer={!renderer} compact={compactChat} />
              )
            ) : content === 'interactive' ? (
              <InteractiveCard terminal={terminal} command={view.command} compact={inGrid} />
            ) : (
              <div className="min-h-0 flex-1 py-2 pl-3 pr-1">
                {renderer && (
                  <Suspense fallback={null}>
                    <XtermView
                      terminalId={terminal.id}
                      label={`Output of ${name}`}
                      redact={masked}
                      onController={onController}
                    />
                  </Suspense>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

const VIEW_LABEL: Record<ClaudeTerminalView, string> = { chat: 'Chat', raw: 'Raw terminal' };

/** A Claude terminal's pane header: Claude's live caption and the chat / raw toggle. */
function ClaudePaneHeader({
  terminal,
  name,
  session,
  accent,
  view,
  inGrid,
  active,
}: {
  terminal: Terminal;
  name: string;
  session: ClaudeSession;
  accent: string;
  view: ClaudeTerminalView;
  inGrid: boolean;
  active: boolean;
}) {
  const caption = useSessionCaption(session);
  return (
    <header
      data-claude-pane={session.id}
      className="flex h-9 shrink-0 items-center gap-2 border-line border-b pr-1 pl-3 text-label"
    >
      {inGrid && (
        <>
          <span aria-hidden className="flex shrink-0">
            <ClaudeOrb state={orbStateFor(session.status)} size={14} accent={accent} />
          </span>
          <span
            title={sessionSubtitle(session) ?? name}
            className={cx('max-w-[40%] shrink-0 truncate', active ? 'text-text-1' : 'text-text-2')}
          >
            {name}
          </span>
        </>
      )}
      {caption && <LiveCaption caption={caption} className="min-w-0 flex-1 text-label" />}
      <fieldset className="ml-auto flex shrink-0 rounded-control border border-line bg-bg-1 p-0.5">
        <legend className="sr-only">Show {name} as</legend>
        {(['chat', 'raw'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === view}
            data-view={option}
            onClick={() => claudeTerminalView.set(terminal.id, option)}
            className={cx(
              'h-6 rounded-chip px-2.5 text-label transition-colors duration-fast',
              option === view
                ? 'bg-bg-2 text-text-1 shadow-raised'
                : 'text-text-2 hover:text-text-1',
            )}
          >
            {VIEW_LABEL[option]}
          </button>
        ))}
      </fieldset>
    </header>
  );
}

/** The chat is already open in the Claude column beside the stack: say so instead of repeating it. */
function ChatBeside({
  session,
  accent,
  compact,
  onShowHere,
}: {
  session: ClaudeSession;
  accent: string;
  compact: boolean;
  onShowHere: (() => void) | undefined;
}) {
  return (
    <div
      data-chat-beside={session.id}
      className={cx(
        'flex min-h-0 flex-1 flex-col items-center justify-center-safe overflow-y-auto text-center',
        compact ? 'gap-2 px-3 py-2' : 'gap-3 px-6 py-4',
      )}
    >
      <ClaudeOrb
        state={orbStateFor(session.status)}
        size={compact ? 20 : 28}
        accent={accent}
        tool={session.status.kind === 'tool' ? session.status.tool : null}
        showToolLabel={false}
      />
      <div className="flex max-w-72 flex-col gap-1">
        <p className="font-medium text-body-sm text-text-1">Chat is open in the Claude column</p>
        {!compact && (
          <p className="text-meta text-text-2">
            Reply there, or switch to the raw terminal to see Claude Code's own screen.
          </p>
        )}
      </div>
      {onShowHere && (
        <button
          type="button"
          data-show-chat-here
          onClick={onShowHere}
          className={buttonClass('secondary', 'sm')}
        >
          Show here instead
        </button>
      )}
    </div>
  );
}

function useEditorName(terminal: Terminal): string {
  return useBoard((s) => selectWindow(terminal.windowId)(s)?.appName) || 'the editor';
}

function useTerminalAction() {
  const client = useBoardClient();
  return async (action: UiAction): Promise<boolean> => {
    const result = await client.action(action);
    if (!result.ok) toast.error(actionErrorText(result.error));
    return result.ok;
  };
}

/**
 * Alt-screen apps can't be mirrored faithfully; point to the editor instead. A grid tile gets
 * the short version (its header already names the command), and never overflows its header.
 */
function InteractiveCard({
  terminal,
  command,
  compact,
}: {
  terminal: Terminal;
  command: string | null;
  compact: boolean;
}) {
  const editor = useEditorName(terminal);
  const act = useTerminalAction();
  const claude = command !== null && /^claude(\s|$)/.test(command);
  return (
    <div
      data-interactive={terminal.id}
      className={cx(
        'flex min-h-0 flex-1 flex-col items-center justify-center-safe overflow-y-auto text-center',
        compact ? 'gap-2 px-3 py-2' : 'gap-3 px-6 py-4',
      )}
    >
      <AppWindow aria-hidden className="size-5 shrink-0 text-text-3" strokeWidth={1.5} />
      {compact ? (
        <p className="font-medium text-body-sm text-text-1">Interactive app</p>
      ) : (
        <div className="flex max-w-72 flex-col gap-1">
          <p className="font-medium text-body-sm text-text-1">Interactive app, open in {editor}</p>
          <p className="text-meta text-text-2">
            {command ? <span className="font-mono text-text-1">{command}</span> : 'This program'}{' '}
            draws full screen, which a mirror can't show faithfully.
            {claude && ' Its conversation is in the Claude panel.'}
          </p>
        </div>
      )}
      <button
        type="button"
        title={`Show in ${editor}`}
        className={cx(buttonClass('secondary', 'sm'), 'max-w-full shrink-0')}
        onClick={() => act({ kind: 'terminal.focus', terminalId: terminal.id })}
      >
        <ExternalLink aria-hidden className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="truncate">Show in {editor}</span>
      </button>
    </div>
  );
}

/** Toolbar, search and command line for the active terminal. */
function ActiveControls({
  terminal,
  claude,
  controller,
}: {
  terminal: Terminal;
  /** A Claude terminal: its composer is the input while the chat shows. */
  claude: boolean;
  controller: () => XtermController | null;
}) {
  const { execution, view } = useTerminalView(terminal);
  const editor = useEditorName(terminal);
  const act = useTerminalAction();
  const open = terminal.state === 'open';
  const [searching, setSearching] = useState(false);
  const redactOn = useRedactOn();
  const masked = useMasked(`term:${terminal.id}`);
  const shown = useClaudeTerminalView(terminal.id);
  const chat = claude && shown === 'chat';
  // No mirror on screen: an alt-screen app's pointer card, or Claude's chat.
  const interactive =
    chat ||
    (!claude && paneKind(execution.id === null ? null : execution, terminal) === 'interactive');

  const interrupt = () => act({ kind: 'terminal.interrupt', terminalId: terminal.id });
  const rerunnable = open && !view.running && execution.id !== null && Boolean(view.command);

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-0.5">
        <Tooltip content="Send Ctrl+C" shortcut="⌃C">
          <button
            type="button"
            aria-label="Send Ctrl+C"
            disabled={!open}
            onClick={interrupt}
            className={cx(buttonClass('ghost', 'sm'), 'px-2 font-mono')}
          >
            ⌃C
          </button>
        </Tooltip>
        <IconButton
          size="sm"
          label={view.command ? `Re-run ${view.command}` : 'Re-run'}
          disabled={!rerunnable}
          icon={<RotateCcw className="size-4" strokeWidth={1.5} />}
          onClick={() => execution.id && act({ kind: 'terminal.rerun', execId: execution.id })}
        />
        <IconButton
          size="sm"
          label={`Show in ${editor}`}
          disabled={!open}
          icon={<ExternalLink className="size-4" strokeWidth={1.5} />}
          onClick={() => act({ kind: 'terminal.focus', terminalId: terminal.id })}
        />
        <span aria-hidden className="mx-1 h-4 w-px bg-line" />
        <IconButton
          size="sm"
          label="Search output"
          aria-pressed={searching}
          disabled={interactive}
          icon={<Search className="size-4" strokeWidth={1.5} />}
          onClick={() => setSearching((s) => !s)}
        />
        <IconButton
          size="sm"
          label="Clear view"
          disabled={interactive}
          icon={<Eraser className="size-4" strokeWidth={1.5} />}
          onClick={() => controller()?.clear()}
        />
        {redactOn && (
          <IconButton
            size="sm"
            label={masked ? 'Reveal secrets' : 'Hide secrets'}
            aria-pressed={!masked}
            disabled={interactive}
            icon={
              masked ? (
                <EyeOff className="size-4" strokeWidth={1.5} />
              ) : (
                <Eye className="size-4" strokeWidth={1.5} />
              )
            }
            onClick={() => reveal.toggle(`term:${terminal.id}`)}
          />
        )}
        <span className="ml-auto min-w-0 truncate pl-2 font-mono text-meta text-text-2">
          {view.running ? 'running' : view.exit ? `exit ${view.exit.code}` : null}
        </span>
      </div>
      {searching && !interactive && (
        <SearchBar controller={controller} onClose={() => setSearching(false)} />
      )}
      {!chat && (
        <CommandLine
          terminal={terminal}
          running={view.running ? view.command : null}
          onInterrupt={interrupt}
        />
      )}
    </div>
  );
}

function SearchBar({
  controller,
  onClose,
}: {
  controller: () => XtermController | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  useEffect(() => controller()?.onSearchResults(setResults), [controller]);
  const find = (direction: 'next' | 'previous') => {
    if (query !== '') controller()?.find(query, direction);
  };
  const close = () => {
    controller()?.clearSearch();
    onClose();
  };
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-control border border-line bg-bg-0 pr-1 pl-3 focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]">
      <Search aria-hidden className="size-3.5 shrink-0 text-text-3" strokeWidth={1.5} />
      <input
        // biome-ignore lint/a11y/noAutofocus: opened on purpose from the toolbar.
        autoFocus
        type="search"
        aria-label="Search terminal output"
        placeholder="Search output"
        value={query}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value === '') controller()?.clearSearch();
          else controller()?.find(e.target.value, 'next');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            find(e.shiftKey ? 'previous' : 'next');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        className="terminal-search h-8 min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-none"
      />
      {query !== '' && results && (
        <span aria-live="polite" className="shrink-0 px-1 font-mono text-meta text-text-2 tabular">
          {results.count === 0 ? 'No matches' : `${results.index + 1}/${results.count}`}
        </span>
      )}
      <IconButton
        size="sm"
        label="Previous match"
        shortcut="⇧↵"
        icon={<ChevronUp className="size-4" strokeWidth={1.5} />}
        onClick={() => find('previous')}
      />
      <IconButton
        size="sm"
        label="Next match"
        shortcut="↵"
        icon={<ChevronDown className="size-4" strokeWidth={1.5} />}
        onClick={() => find('next')}
      />
      <IconButton
        size="sm"
        label="Close search"
        shortcut="Esc"
        icon={<X className="size-4" strokeWidth={1.5} />}
        onClick={close}
      />
    </div>
  );
}

const HISTORY_MAX = 50;

/**
 * Sends a line to the terminal (`cmd.sendText`). At the prompt it runs as a command; while a
 * program runs, it is that program's input. ↑/↓ walk this view's history; ⌃C interrupts.
 */
function CommandLine({
  terminal,
  running,
  onInterrupt,
}: {
  terminal: Terminal;
  running: string | null;
  onInterrupt: () => void;
}) {
  const act = useTerminalAction();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const history = useRef<string[]>([]);
  const cursor = useRef<number | null>(null);
  const open = terminal.state === 'open';

  const submit = async () => {
    if (!open || sending) return;
    setSending(true);
    const text = value;
    const ok = await act({
      kind: 'terminal.sendText',
      terminalId: terminal.id,
      text,
      execute: true,
    });
    setSending(false);
    if (!ok) return;
    if (text.trim() !== '' && history.current.at(-1) !== text) {
      history.current = [...history.current, text].slice(-HISTORY_MAX);
    }
    cursor.current = null;
    setValue('');
  };

  const walk = (step: -1 | 1) => {
    const items = history.current;
    if (items.length === 0) return;
    const from = cursor.current ?? items.length;
    const next = Math.min(items.length, Math.max(0, from + step));
    cursor.current = next === items.length ? null : next;
    setValue(next === items.length ? '' : (items[next] ?? ''));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-control border border-line bg-bg-0 pr-1.5 pl-3 transition-colors duration-fast focus-within:border-line-strong focus-within:shadow-[var(--focus-ring)]',
        !open && 'opacity-60',
      )}
    >
      <span aria-hidden className="font-mono text-label text-text-3">
        {running ? '›' : '$'}
      </span>
      <input
        aria-label={`Send to ${terminalDisplayName(terminal).name}`}
        data-command-line={terminal.id}
        disabled={!open}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        placeholder={
          !open
            ? 'Terminal closed'
            : running
              ? `Input for ${running}`
              : `Run in ${terminalDisplayName(terminal).name}`
        }
        onChange={(e) => {
          setValue(e.target.value);
          cursor.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key === 'c' && e.ctrlKey && !e.metaKey && !e.altKey) {
            const input = e.currentTarget;
            if (input.selectionStart === input.selectionEnd) {
              e.preventDefault();
              setValue('');
              onInterrupt();
            }
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            walk(e.key === 'ArrowUp' ? -1 : 1);
          }
        }}
        className="h-9 min-w-0 flex-1 bg-transparent font-mono text-label text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-none disabled:cursor-not-allowed"
      />
      <Kbd className="text-text-3">{sending ? '…' : '↵'}</Kbd>
    </form>
  );
}

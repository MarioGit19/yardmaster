import * as Dialog from '@radix-ui/react-dialog';
import {
  type ClaudeSession,
  type Project,
  sessionDisplayName,
  type Terminal,
} from '@yardmaster/protocol';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  GitBranch,
  History,
  Plug,
  Plus,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation } from 'wouter';
import { ClaudePanel } from '../../claude/ClaudePanel.js';
import { useComposerLift } from '../../claude/composerLift.js';
import {
  selectApproval,
  selectHydrated,
  selectPortsByProject,
  selectPortsByTerminal,
  selectSession,
  selectSessionsByProject,
  selectTerminal,
  selectTerminalsByProject,
  useBoard,
  useBoardList,
  useBoardShallow,
} from '../../data/index.js';
import { DraftMarker } from '../../drafts/DraftMarker.js';
import { draftKey } from '../../drafts/drafts.js';
import { GitPanel } from '../../git/GitPanel.js';
import { useSessionHistory } from '../../history/api.js';
import { historyRefreshKey, listedSessionIds, pastSessions } from '../../history/model.js';
import { SessionHistory } from '../../history/SessionHistory.js';
import { laneView, selectLaneExecution, terminalDisplay } from '../../lanes/lane.js';
import { PortChip, portProcess } from '../../lanes/PortChip.js';
import { dur, ease, move, spring, useMotionLevel } from '../../motion.js';
import { ClaudeOrb } from '../../orb/ClaudeOrb.js';
import { orbStateFor } from '../../orb/model.js';
import { useHeldOrder } from '../../order.js';
import { countOf } from '../../plural.js';
import { LiveCaption } from '../../pod/LiveCaption.js';
import { type Caption, sessionCaption } from '../../pod/model.js';
import { createPreference, usePreference } from '../../prefs.js';
import { projectHref, projectPageHref, terminalHref } from '../../routes.js';
import { ProjectAvatar } from '../../shell/ProjectAvatar.js';
import { historyTrack, leaveWorkspace } from '../../shell/phoneNav.js';
import type { Tone } from '../../status.js';
import { laneWithToken, sessionView, terminalToken, useStatusReader } from '../../statusTokens.js';
import { claudeTerminalView, useClaudeTerminalView } from '../../terminal/claudeTerminal.js';
import { NewTerminalForm } from '../../terminal/NewTerminalPopover.js';
import {
  arrivedTerminal,
  newTerminalRequest,
  useNewTerminalRequest,
} from '../../terminal/newTerminal.js';
import { TerminalItem } from '../../terminal/TerminalStack.js';
import { terminalTarget, useTerminalTarget } from '../../terminal/target.js';
import { SheetPanel } from '../../ui/BottomSheet.js';
import { buttonClass } from '../../ui/Button.js';
import { cx } from '../../ui/cx.js';
import { StatusDot } from '../../ui/StatusDot.js';
import { EmptyState } from '../../views/Page.js';
import { NewSessionPanel } from '../NewSessionPanel.js';
import { useStatusWord } from '../skins/registry.js';
import type { HubCrewProps } from '../skins/types.js';
import { useTabSwipe } from '../swipe.js';
import { WorkspaceMenu } from '../WorkspaceMenu.js';
import {
  HUB_GROUP_LABEL,
  HUB_GROUPS,
  type HubItem,
  type HubPage,
  hubFailures,
  hubItems,
  hubItemsKey,
  isHubPage,
  itemHref,
  neighbour,
  otherNeedsYou,
  parseHubItems,
  routeItem,
} from './model.js';

/** The hub's one-line hint, until it is dismissed in this browser. */
const hintPreference = createPreference('yardmaster.hubHint', ['show', 'hidden'] as const, 'show');

const PAGE_TITLE: Record<HubPage, string> = {
  git: 'Git',
  history: 'History',
  ports: 'Ports',
  new: 'New session',
};

export interface PhoneWorkspaceProps {
  project: Project;
  sessionId?: string;
  terminalId?: string;
  page?: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** The skin's crew beside the project's name in the hub (Office, DESIGN.md §10.8). */
  HubCrew?: ComponentType<HubCrewProps>;
}

/** Steps through the history without the router losing the entry's index stamp. */
const replaceKeepingStamp = (navigate: ReturnType<typeof useLocation>[1], href: string) =>
  navigate(href, { replace: true, state: window.history.state });

const itemKey = (item: HubItem) => item.key;

/**
 * The phone workspace (DESIGN.md §11): the project hub (one list of everything in the project,
 * grouped by what needs the user) with an item page over it for a chat or a terminal, and pages
 * for git, history, ports and a new session. The hub stays mounted underneath, so its scroll
 * position survives a visit to an item.
 */
export function PhoneWorkspace({
  project,
  sessionId,
  terminalId,
  page,
  headingRef,
  HubCrew,
}: PhoneWorkspaceProps) {
  const [, navigate] = useLocation();
  const hydrated = useBoard(selectHydrated);
  const key = useBoard((s) => hubItemsKey(hubItems(s.board, project.id)));
  const items = useMemo(() => parseHubItems(key), [key]);
  const hub = projectHref(project.id);
  const item = routeItem(items, { sessionId, terminalId });
  const subPage = page && isHubPage(page) ? page : null;
  const onItem = Boolean(sessionId || terminalId);
  const open = onItem || subPage !== null;

  // Opened straight onto an item or a page (a deep link, a notification, ⌘K): slide the hub under
  // it, so back lands on the hub. After the shell has stamped this entry, hence the timeout.
  const mountedOn = useRef(open);
  useEffect(() => {
    if (!mountedOn.current) return;
    const timer = setTimeout(() => historyTrack.placeBelow(hub));
    return () => clearTimeout(timer);
  }, [hub]);

  // A terminal picked in ⌘K or the Pulse opens its page.
  const target = useTerminalTarget(project.id);
  useEffect(() => {
    if (target === null) return;
    terminalTarget.set(null);
    if (target !== terminalId) navigate(terminalHref(project.id, target));
  }, [target, terminalId, project.id, navigate]);

  // "New terminal" from ⌘K, the pod's menu or the overflow menu opens the + New sheet.
  const [adding, setAdding] = useState(false);
  const requested = useNewTerminalRequest(project.id);
  useEffect(() => {
    if (!requested) return;
    newTerminalRequest.set(null);
    setAdding(true);
  }, [requested]);

  // The card last opened, marked on the hub and focused on the way back.
  const [last, setLast] = useState<string | null>(item?.key ?? null);
  useEffect(() => {
    if (item) setLast(item.key);
  }, [item]);
  const back = () => {
    if (historyTrack.previous() === hub) window.history.back();
    else replaceKeepingStamp(navigate, hub);
  };
  const goTo = (next: HubItem) => replaceKeepingStamp(navigate, itemHref(project.id, next));
  // The order a swipe walks: the hub's when an item page opened, held until back on the hub. A
  // terminal whose command ends moves to Idle there, not under the finger.
  const swipeOrder = useHeldOrder(items, itemKey, onItem);

  const still = useMotionLevel() !== 'full';
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Hub
        project={project}
        items={items}
        hidden={open}
        last={last}
        headingRef={headingRef}
        HubCrew={HubCrew}
        onAdd={() => setAdding(true)}
        onNewSession={() => navigate(projectPageHref(project.id, 'new'))}
      />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="page"
            data-workspace-page={subPage ?? 'item'}
            initial={{ opacity: 0, transform: move(still, 'translateX(24px)') }}
            animate={{
              opacity: 1,
              transform: move(still, 'translateX(0px)'),
              transition: {
                default: spring.smooth,
                opacity: { duration: dur.base, ease: ease.out },
              },
              transitionEnd: { transform: 'none' },
            }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
            className="absolute inset-0 z-10 flex min-h-0 flex-col bg-bg-1"
          >
            {subPage ? (
              <SubPage project={project} page={subPage} items={items} onBack={back} />
            ) : item ? (
              <ItemPage
                project={project}
                item={item}
                items={items}
                order={swipeOrder}
                onBack={back}
                onGo={goTo}
              />
            ) : (
              <MissingItem
                project={project}
                loading={!hydrated}
                terminal={Boolean(terminalId)}
                onBack={back}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <NewSheet project={project} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

const appBarClass =
  'relative flex min-w-0 shrink-0 items-center gap-2 border-line border-b px-1 pt-[env(safe-area-inset-top)]';
const appBarStyle = { minHeight: 'calc(56px + env(safe-area-inset-top))' };
const backClass =
  'grid size-11 shrink-0 place-items-center rounded-control text-text-2 transition-[background-color,color,scale] duration-fast ease-out hover:bg-bg-2 hover:text-text-1 moving:active:scale-[0.97]';

function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts="Escape"
      data-workspace-back=""
      onClick={onClick}
      className={backClass}
    >
      <ArrowLeft aria-hidden className="size-5" strokeWidth={1.5} />
    </button>
  );
}

// —— The hub ————————————————————————————————————————————————————————————————————————————————

function Hub({
  project,
  items,
  hidden,
  last,
  headingRef,
  HubCrew,
  onAdd,
  onNewSession,
}: {
  project: Project;
  items: readonly HubItem[];
  /** An item or page covers it: it stays mounted (and keeps its scroll), out of reach. */
  hidden: boolean;
  last: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  HubCrew?: ComponentType<HubCrewProps>;
  onAdd: () => void;
  onNewSession: () => void;
}) {
  const [, navigate] = useLocation();
  const listRef = useRef<HTMLDivElement>(null);
  // Back on the hub, the card the user came from takes the focus again.
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (wasHidden.current && !hidden && last) {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-hub-item="${CSS.escape(last)}"]`)
        ?.focus({ preventScroll: true });
    }
    wasHidden.current = hidden;
  }, [hidden, last]);
  const hint = usePreference(hintPreference);
  const lift = useComposerLift();
  return (
    <div
      data-hub={project.id}
      inert={hidden}
      aria-hidden={hidden || undefined}
      className={cx('flex min-h-0 flex-1 flex-col', hidden && 'invisible')}
    >
      <header data-workspace-appbar="" className={appBarClass} style={appBarStyle}>
        <BackButton onClick={() => leaveWorkspace(navigate)} />
        <ProjectAvatar project={project} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1
            ref={headingRef}
            tabIndex={-1}
            title={project.name}
            className="truncate font-medium text-body text-text-1 outline-none focus-visible:shadow-none"
          >
            {project.name}
          </h1>
          {project.git?.branch && (
            <p className="truncate font-mono text-label text-text-2" title={project.git.branch}>
              {project.git.branch}
            </p>
          )}
        </div>
        {HubCrew && <HubCrew projectId={project.id} />}
        <WorkspaceMenu project={project} onNewSession={onNewSession} />
      </header>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
        <Summary project={project} items={items} />
        {hint === 'show' && (
          <p
            data-hub-hint=""
            className="mt-3 flex min-w-0 items-center gap-2 rounded-control border border-line bg-bg-2 py-1 pr-1 pl-3 text-meta text-text-2"
          >
            <span className="min-w-0 flex-1">Tap anything to open it. Tap its name to switch.</span>
            <button
              type="button"
              onClick={() => hintPreference.set('hidden')}
              className={cx(buttonClass('ghost', 'sm'), 'shrink-0')}
            >
              Got it
            </button>
          </p>
        )}
        {items.length === 0 ? (
          <div className="py-6">
            <EmptyState title="Nothing here yet">
              Start a Claude session or a terminal with + New.
            </EmptyState>
          </div>
        ) : (
          <ItemGroups items={items} projectId={project.id} last={last} />
        )}
        <PageRows project={project} />
      </div>
      {/* Toasts sit above + New, as above a composer. */}
      <div
        ref={lift}
        className="shrink-0 border-line border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]"
      >
        <button
          type="button"
          data-hub-new=""
          aria-haspopup="dialog"
          onClick={onAdd}
          className={cx(buttonClass('primary', 'md'), 'h-12 w-full touch:h-12 text-body')}
        >
          <Plus aria-hidden className="size-5" strokeWidth={1.75} />
          New
        </button>
      </div>
    </div>
  );
}

/** "2 working · 1 needs you · 1 failed · :3000 serving". */
function Summary({ project, items }: { project: Project; items: readonly HubItem[] }) {
  const ports = useBoardList(selectPortsByProject(project.id));
  const failed = useBoard((s) => hubFailures(s.board, items));
  const needs = items.filter((i) => i.group === 'needs').length;
  const running = items.filter((i) => i.group === 'running').length;
  const listening = [...new Set(ports.map((p) => p.port))].sort((a, b) => a - b);
  const parts = [
    running > 0 && `${running} working`,
    needs > 0 && `${needs} needs you`,
    failed > 0 && `${failed} failed`,
    listening.length === 1 && `:${listening[0]} serving`,
    listening.length > 1 && `${listening.length} ports serving`,
  ].filter(Boolean);
  return (
    <p data-hub-summary="" className="truncate text-body-sm text-text-2 tabular">
      {parts.length > 0 ? parts.join(' · ') : 'All quiet'}
    </p>
  );
}

function ItemGroups({
  items,
  projectId,
  last,
}: {
  items: readonly HubItem[];
  projectId: string;
  last: string | null;
}) {
  return (
    <>
      {HUB_GROUPS.map((group) => {
        const members = items.filter((i) => i.group === group);
        if (members.length === 0) return null;
        return (
          <section
            key={group}
            data-hub-group={group}
            aria-labelledby={`hub-group-${group}`}
            className="mt-5"
          >
            <h2
              id={`hub-group-${group}`}
              className={cx(
                'mb-2 font-medium text-label',
                group === 'needs' ? 'text-st-wait-ink' : 'text-text-2',
              )}
            >
              {HUB_GROUP_LABEL[group]}
              <span className="ml-1.5 font-mono text-text-3 tabular">{members.length}</span>
            </h2>
            <ul className="flex flex-col gap-2">
              {members.map((item) => (
                <li key={item.key}>
                  <HubCard item={item} projectId={projectId} last={item.key === last} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

// —— Items ——————————————————————————————————————————————————————————————————————————————————

interface ItemView {
  name: string;
  tone: Tone;
  /** The status in the skin's words. */
  status: string;
  /** The status in the standard words, which a caption saying the same repeats. */
  label: string;
  caption: Caption | null;
  session: ClaudeSession | undefined;
  terminal: Terminal | undefined;
}

const NO_TERMINAL = { executionIds: [] as string[] };

/** What a card, a page header or the switcher shows for an item. */
function useItemView(item: HubItem): ItemView {
  const session = useBoard(selectSession(item.kind === 'session' ? item.sessionId : ''));
  const approvalId =
    session?.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const terminal = useBoard(selectTerminal(item.terminalId ?? ''));
  const execution = useBoardShallow(selectLaneExecution(terminal ?? NO_TERMINAL));
  const word = useStatusWord();
  const readStatus = useStatusReader();
  if (item.kind === 'session' && session) {
    const status = sessionView(session, readStatus());
    return {
      name: sessionDisplayName(session),
      tone: status.tone,
      status:
        status.tone === 'stale' || status.tone === 'ok'
          ? status.label
          : word({ kind: 'session', status: session.status }, status.label),
      label: status.label,
      caption: sessionCaption(session, approval),
      session,
      terminal,
    };
  }
  if (terminal) {
    const display = terminalDisplay(terminal, execution);
    const lane = laneView(terminal, execution, display.name);
    const view = laneWithToken(lane, terminalToken(terminal, execution, lane, readStatus()));
    const status =
      view.tone === 'stale'
        ? 'Stale'
        : view.running
          ? 'Running'
          : view.exit
            ? view.exit.code === 0
              ? 'Finished'
              : `Failed, exit ${view.exit.code}`
            : terminal.state === 'closed'
              ? 'Closed'
              : 'Idle';
    return {
      name: display.name,
      tone: view.tone,
      status: word(
        {
          kind: 'terminal',
          running: view.running,
          exit: view.exit?.code ?? null,
          closed: terminal.state === 'closed',
        },
        status,
      ),
      label: status,
      caption:
        view.command && view.command !== display.name
          ? { glyph: null, text: view.command, tone: 'rest' }
          : null,
      session: undefined,
      terminal,
    };
  }
  return {
    name: 'Unavailable',
    tone: 'idle',
    status: 'Gone',
    label: 'Gone',
    caption: null,
    session: undefined,
    terminal: undefined,
  };
}

function ItemIcon({ view, accent, size = 24 }: { view: ItemView; accent?: string; size?: number }) {
  return (
    <span aria-hidden className="grid shrink-0 place-items-center" style={{ width: size }}>
      {view.session ? (
        <ClaudeOrb
          state={orbStateFor(view.session.status)}
          size={size}
          accent={accent}
          tool={view.session.status.kind === 'tool' ? view.session.status.tool : null}
          showToolLabel={false}
        />
      ) : (
        <SquareTerminal className="size-5 text-text-2" strokeWidth={1.5} />
      )}
    </span>
  );
}

/** The kind of an item in words: a chat, a chat in a terminal, or a terminal. */
const kindLabel = (item: HubItem) =>
  item.kind === 'terminal' ? 'Terminal' : item.terminalId ? 'Claude in a terminal' : 'Claude';

/** What a waiting chat waits for: an approval or an answer. */
const waitKind = (session: ItemView['session']) =>
  session?.status.kind === 'waiting_permission'
    ? 'approval'
    : session?.status.kind === 'waiting_input'
      ? 'answer'
      : undefined;

function HubCard({ item, projectId, last }: { item: HubItem; projectId: string; last: boolean }) {
  const view = useItemView(item);
  const ports = useBoardList(selectPortsByTerminal(item.terminalId ?? ''));
  return (
    <Link
      href={itemHref(projectId, item)}
      data-hub-item={item.key}
      data-hub-kind={item.kind}
      data-hub-terminal={item.terminalId ?? undefined}
      data-origin={view.session?.origin}
      data-hub-wait={waitKind(view.session)}
      data-last={last || undefined}
      className={cx(
        'flex min-w-0 items-start gap-3 rounded-panel border bg-bg-1 p-3 shadow-raised focus-visible:shadow-[var(--focus-ring)] transition-[border-color,background-color,scale] duration-fast ease-out hover:border-line-strong moving:active:scale-[0.99]',
        item.group === 'needs' ? 'border-st-wait/60' : last ? 'border-line-strong' : 'border-line',
      )}
    >
      <span className="pt-0.5">
        <ItemIcon view={view} accent="var(--accent)" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            data-hub-name=""
            className="min-w-0 flex-1 truncate font-medium text-body text-text-1"
          >
            {view.name}
          </span>
          {item.kind === 'session' && <DraftMarker draft={draftKey.session(item.sessionId)} />}
          <span className="shrink-0 text-meta text-text-2">{kindLabel(item)}</span>
        </span>
        <StatusDot
          tone={view.tone}
          label={view.status}
          showLabel
          className="min-w-0 text-meta text-text-2"
        />
        {view.caption && view.caption.text !== view.label && (
          <LiveCaption caption={view.caption} className="text-body-sm" />
        )}
        {ports.length > 0 && (
          <span className="truncate font-mono text-meta text-text-2 tabular">
            {ports.map((p) => `:${p.port}`).join('  ')}
          </span>
        )}
      </span>
      <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-text-3" strokeWidth={1.5} />
    </Link>
  );
}

/** Git, History and Ports: rows under the list that open their own pages. */
function PageRows({ project }: { project: Project }) {
  const ports = useBoardList(selectPortsByProject(project.id));
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const knownIds = useMemo(() => listedSessionIds(sessions), [sessions]);
  const { state } = useSessionHistory(project.id, historyRefreshKey(sessions));
  const past = state.status === 'ready' ? pastSessions(state.sessions, knownIds).length : null;
  const git = project.git;
  const rows = [
    {
      page: 'git' as const,
      icon: <GitBranch />,
      detail: git?.statusSkipped
        ? 'git status skipped'
        : git
          ? `${git.branch ?? 'detached'} · ${git.dirty > 0 ? `${git.dirty} changed` : 'clean'}`
          : 'Not a git repository',
    },
    {
      page: 'history' as const,
      icon: <History />,
      detail: past === null ? 'Past sessions' : countOf(past, 'past session'),
    },
    {
      page: 'ports' as const,
      icon: <Plug />,
      detail:
        ports.length === 0
          ? 'Nothing listening'
          : ports
              .map((p) => `:${p.port}`)
              .slice(0, 4)
              .join('  '),
    },
  ];
  return (
    <nav aria-label="More of this project" className="mt-6 flex flex-col">
      {rows.map((row) => (
        <Link
          key={row.page}
          href={projectPageHref(project.id, row.page)}
          data-hub-row={row.page}
          className="flex min-h-14 min-w-0 items-center gap-3 border-line border-t px-1 transition-colors duration-fast hover:bg-bg-2/60 [&:last-child]:border-b"
        >
          <span
            aria-hidden
            className="flex shrink-0 text-text-2 [&_svg]:size-5 [&_svg]:stroke-[1.5]"
          >
            {row.icon}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body text-text-1">{PAGE_TITLE[row.page]}</span>
            <span className="truncate font-mono text-meta text-text-2">{row.detail}</span>
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.5} />
        </Link>
      ))}
    </nav>
  );
}

// —— Item pages —————————————————————————————————————————————————————————————————————————————

function ItemPage({
  project,
  item,
  items,
  order,
  onBack,
  onGo,
}: {
  project: Project;
  item: HubItem;
  items: readonly HubItem[];
  /** The order a swipe walks (`useHeldOrder`). */
  order: readonly HubItem[];
  onBack: () => void;
  onGo: (item: HubItem) => void;
}) {
  const view = useItemView(item);
  const [switching, setSwitching] = useState(false);
  const claudeTerminal = item.kind === 'session' ? item.terminalId : null;
  const shown = useClaudeTerminalView(claudeTerminal ?? '');
  const needs = otherNeedsYou(items, item.key);
  // Which way the content slides in after a swipe: from the side the finger came from.
  const [direction, setDirection] = useState<1 | -1 | 0>(0);
  const swipe = useTabSwipe((step) => {
    const next = neighbour(order, item.key, step);
    if (!next) return;
    setDirection(step);
    onGo(next);
  });
  const still = useMotionLevel() !== 'full';
  const accent = 'var(--accent)';
  // The whole page takes the swipe; the terminal's output and text fields keep their own drags.
  return (
    <div
      data-item-swipe={order.map((i) => i.key).join(' ')}
      className="flex min-h-0 flex-1 flex-col"
      {...swipe}
    >
      <header data-item-header={item.key} className={appBarClass} style={appBarStyle}>
        <BackButton onClick={onBack} label={`Back to ${project.name}`} />
        <button
          type="button"
          data-item-switch=""
          aria-haspopup="dialog"
          aria-expanded={switching}
          onClick={() => setSwitching(true)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-control px-1.5 text-left transition-colors duration-fast hover:bg-bg-2"
        >
          <ItemIcon view={view} accent={accent} size={20} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1">
              <h2 data-item-name="" className="truncate font-medium text-body text-text-1">
                {view.name}
              </h2>
              <ChevronDown aria-hidden className="size-4 shrink-0 text-text-2" strokeWidth={1.5} />
            </span>
            <StatusDot
              tone={view.tone}
              label={view.status}
              showLabel
              className="min-w-0 text-meta text-text-2"
            />
          </span>
        </button>
      </header>
      {claudeTerminal && (
        <fieldset
          data-item-view=""
          className="mx-4 mt-2 flex shrink-0 rounded-control border border-line bg-bg-0 p-0.5"
        >
          <legend className="sr-only">Show {view.name} as</legend>
          {(['chat', 'raw'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === shown}
              data-view={option}
              onClick={() => claudeTerminalView.set(claudeTerminal, option)}
              className={cx(
                'h-11 flex-1 rounded-chip text-body-sm transition-colors duration-fast',
                option === shown
                  ? `bg-bg-2 text-text-1 shadow-raised focus-visible:shadow-[var(--focus-ring)]`
                  : 'text-text-2 hover:text-text-1',
              )}
            >
              {option === 'chat' ? 'Chat' : 'Terminal'}
            </button>
          ))}
        </fieldset>
      )}
      {needs && <NeedsYouBar item={needs} onOpen={() => onGo(needs)} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={item.key}
            initial={{
              opacity: 0,
              transform: move(still, `translateX(${direction * 24}px)`),
            }}
            animate={{
              opacity: 1,
              transform: move(still, 'translateX(0px)'),
              transition: {
                default: spring.smooth,
                opacity: { duration: dur.base, ease: ease.out },
              },
              transitionEnd: { transform: 'none' },
            }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <ItemContent item={item} view={view} chat={!claudeTerminal || shown === 'chat'} />
          </motion.div>
        </AnimatePresence>
      </div>
      <Switcher
        projectName={project.name}
        items={items}
        current={item.key}
        open={switching}
        onOpenChange={setSwitching}
        onPick={(next) => {
          setSwitching(false);
          if (next.key === item.key) return;
          setDirection(0);
          onGo(next);
        }}
      />
    </div>
  );
}

function ItemContent({ item, view, chat }: { item: HubItem; view: ItemView; chat: boolean }) {
  if (item.kind === 'session' && view.session && chat) {
    return <ClaudePanel session={view.session} header={false} />;
  }
  if (view.terminal) return <TerminalItem terminal={view.terminal} accent="var(--accent)" />;
  return (
    <EmptyState title="This is no longer available">It may have ended or been removed.</EmptyState>
  );
}

/** Another item in the project needs the user: a slim amber bar that opens it. */
function NeedsYouBar({ item, onOpen }: { item: HubItem; onOpen: () => void }) {
  const view = useItemView(item);
  return (
    <button
      type="button"
      data-needs-you-bar={item.key}
      onClick={onOpen}
      className="mx-4 mt-2 flex min-h-11 shrink-0 items-center gap-2 rounded-control border border-st-wait/50 bg-st-wait/10 px-3 text-left text-body-sm text-st-wait-ink transition-colors duration-fast hover:bg-st-wait/15"
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full border-[1.5px] border-st-wait" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{view.name}</span> needs you
      </span>
      <span className="shrink-0 font-medium">Open</span>
    </button>
  );
}

/** Every item of the project in the hub's groups, to jump between them. */
function Switcher({
  projectName,
  items,
  current,
  open,
  onOpenChange,
  onPick,
}: {
  projectName: string;
  items: readonly HubItem[];
  current: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (item: HubItem) => void;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      data="switcher"
      title={`Switch in ${projectName}`}
    >
      <div className="min-h-0 overflow-y-auto px-4 pb-2">
        {HUB_GROUPS.map((group) => {
          const members = items.filter((i) => i.group === group);
          if (members.length === 0) return null;
          return (
            <section key={group} aria-label={HUB_GROUP_LABEL[group]} className="mb-3">
              <h3 className="mb-1 font-medium text-label text-text-2">{HUB_GROUP_LABEL[group]}</h3>
              <ul className="flex flex-col">
                {members.map((item) => (
                  <li key={item.key}>
                    <SwitcherRow
                      item={item}
                      current={item.key === current}
                      onPick={() => onPick(item)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Sheet>
  );
}

function SwitcherRow({
  item,
  current,
  onPick,
}: {
  item: HubItem;
  current: boolean;
  onPick: () => void;
}) {
  const view = useItemView(item);
  return (
    <button
      type="button"
      data-switcher-item={item.key}
      aria-current={current || undefined}
      onClick={onPick}
      className={cx(
        'flex min-h-12 w-full min-w-0 items-center gap-3 rounded-control px-2 text-left transition-colors duration-fast hover:bg-bg-2',
        current && 'bg-bg-2',
      )}
    >
      <ItemIcon view={view} accent="var(--accent)" size={20} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-text-1">{view.name}</span>
        <StatusDot
          tone={view.tone}
          label={`${kindLabel(item)} · ${view.status}`}
          showLabel
          className="min-w-0 text-meta text-text-2"
        />
      </span>
    </button>
  );
}

function MissingItem({
  project,
  loading,
  terminal,
  onBack,
}: {
  project: Project;
  loading: boolean;
  terminal: boolean;
  onBack: () => void;
}) {
  return (
    <>
      <header className={appBarClass} style={appBarStyle}>
        <BackButton onClick={onBack} label={`Back to ${project.name}`} />
        <h2 className="min-w-0 flex-1 truncate font-medium text-body text-text-1">
          {loading ? 'Loading…' : terminal ? 'Terminal' : 'Session'}
        </h2>
      </header>
      {!loading && (
        <EmptyState
          title={
            terminal ? 'This terminal is no longer open' : 'This session is no longer available'
          }
        >
          <button type="button" onClick={onBack} className="underline underline-offset-2">
            Back to {project.name}
          </button>
        </EmptyState>
      )}
    </>
  );
}

// —— Pages ——————————————————————————————————————————————————————————————————————————————————

function SubPage({
  project,
  page,
  items,
  onBack,
}: {
  project: Project;
  page: HubPage;
  items: readonly HubItem[];
  onBack: () => void;
}) {
  return (
    <>
      <header className={appBarClass} style={appBarStyle}>
        <BackButton onClick={onBack} label={`Back to ${project.name}`} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate font-medium text-body text-text-1">{PAGE_TITLE[page]}</h2>
          <p className="truncate text-label text-text-2">{project.name}</p>
        </div>
      </header>
      {page === 'new' ? (
        <NewSessionPanel project={project} header={false} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          {page === 'git' ? (
            <GitPanel git={project.git} now={Date.now()} />
          ) : page === 'history' ? (
            <HistoryPage project={project} />
          ) : (
            <PortsPage project={project} items={items} />
          )}
        </div>
      )}
    </>
  );
}

function HistoryPage({ project }: { project: Project }) {
  const sessions = useBoardList(selectSessionsByProject(project.id));
  const knownIds = useMemo(() => listedSessionIds(sessions), [sessions]);
  return (
    <SessionHistory
      page
      projectId={project.id}
      knownIds={knownIds}
      refreshKey={historyRefreshKey(sessions)}
      branch={project.git?.branch ?? null}
    />
  );
}

function PortsPage({ project, items }: { project: Project; items: readonly HubItem[] }) {
  const ports = useBoardList(selectPortsByProject(project.id));
  const sorted = [...ports].sort((a, b) => a.port - b.port || a.id.localeCompare(b.id));
  if (sorted.length === 0) {
    return (
      <EmptyState title="Nothing listening">
        Dev servers this project starts show up here.
      </EmptyState>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((port) => {
        const owner = items.find((i) => i.terminalId === port.terminalId);
        return (
          <li
            key={port.id}
            data-port-row={port.port}
            className="flex min-w-0 flex-col gap-2 rounded-panel border border-line bg-bg-1 p-3"
          >
            <span className="flex min-w-0 items-center gap-2">
              <PortChip port={port} />
              <span className="min-w-0 truncate font-mono text-meta text-text-2">
                {portProcess(port)}
              </span>
            </span>
            {owner && <PortOwner projectId={project.id} item={owner} />}
          </li>
        );
      })}
    </ul>
  );
}

function PortOwner({ projectId, item }: { projectId: string; item: HubItem }) {
  const view = useItemView(item);
  return (
    <Link
      href={itemHref(projectId, item)}
      className={cx(buttonClass('ghost', 'sm'), 'max-w-full justify-start self-start')}
    >
      <SquareTerminal aria-hidden className="size-3.5 shrink-0" strokeWidth={1.5} />
      <span className="truncate">Open {view.name}</span>
    </Link>
  );
}

// —— Sheets —————————————————————————————————————————————————————————————————————————————————

function Sheet({
  open,
  onOpenChange,
  title,
  data,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** `data-<data>-sheet` on the panel, for tests. */
  data: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="palette-overlay fixed inset-0 z-50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: dur.base, ease: ease.out } }}
                exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <SheetPanel
                {...{ [`data-${data}-sheet`]: '' }}
                onDismiss={() => onOpenChange(false)}
                className="pb-[max(8px,env(safe-area-inset-bottom))]"
              >
                <div className="flex min-w-0 shrink-0 items-center gap-2 px-4 pb-3">
                  <Dialog.Title className="min-w-0 flex-1 truncate font-medium text-body text-text-1">
                    {title}
                  </Dialog.Title>
                  <Dialog.Close className={cx(buttonClass('ghost', 'sm'), 'shrink-0')}>
                    <X aria-hidden className="size-4" strokeWidth={1.5} />
                    Close
                  </Dialog.Close>
                </div>
                {children}
              </SheetPanel>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/** + New: a Claude session, or a terminal (typed, `claude`, or a recent command). */
function NewSheet({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const terminals = useBoardList(selectTerminalsByProject(project.id));
  // The new terminal's page opens once the editor (or the board) reports it.
  const [awaiting, setAwaiting] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!awaiting) return;
    const arrived = arrivedTerminal(awaiting, terminals);
    if (arrived === null) {
      const timer = setTimeout(() => setAwaiting(null), 20_000);
      return () => clearTimeout(timer);
    }
    setAwaiting(null);
    navigate(terminalHref(project.id, arrived));
  }, [awaiting, terminals, navigate, project.id]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} data="new" title={`New in ${project.name}`}>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-2">
        <button
          type="button"
          data-new-claude=""
          onClick={() => {
            onOpenChange(false);
            navigate(projectPageHref(project.id, 'new'));
          }}
          className="flex min-h-16 min-w-0 items-center gap-3 rounded-panel border border-line bg-bg-2 px-4 text-left shadow-raised focus-visible:shadow-[var(--focus-ring)] transition-[border-color,scale] duration-fast ease-out hover:border-line-strong moving:active:scale-[0.99]"
        >
          <Sparkles aria-hidden className="size-5 shrink-0 text-text-2" strokeWidth={1.5} />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-body text-text-1">Claude session</span>
            <span className="text-meta text-text-2">A new chat with Claude in this project</span>
          </span>
        </button>
        <section
          aria-labelledby="new-terminal-title"
          data-new-terminal-sheet=""
          className="flex flex-col gap-3"
        >
          <h3
            id="new-terminal-title"
            className="flex items-center gap-2 font-medium text-body text-text-1"
          >
            <SquareTerminal aria-hidden className="size-5 text-text-2" strokeWidth={1.5} />
            Terminal
          </h3>
          <NewTerminalForm
            projectId={project.id}
            projectName={project.name}
            onCreated={() => {
              onOpenChange(false);
              setAwaiting(new Set(terminals.map((t) => t.id)));
            }}
          />
        </section>
      </div>
    </Sheet>
  );
}

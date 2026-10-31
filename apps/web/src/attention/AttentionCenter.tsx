import {
  type Approval,
  type ClaudeSession,
  sessionDisplayName,
  sessionSubtitle,
} from '@yardmaster/protocol';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'wouter';
import { useNow } from '../anim/clock.js';
import {
  selectPendingApprovals,
  selectProject,
  useBoard,
  useBoardClient,
  useBoardList,
  useBoardStore,
} from '../data/index.js';
import { dur, ease, type MotionLevel, move, spring, useMotionLevel } from '../motion.js';
import { sessionCaption, sessionSummary } from '../pod/model.js';
import { usePreference } from '../prefs.js';
import { routes, sessionHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { isTypingTarget } from '../shell/railNav.js';
import { STALE_TICK_MS } from '../statusTokens.js';
import { formatWaited } from '../time.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import { NumberTicker } from '../ui/NumberTicker.js';
import { StatusDot } from '../ui/StatusDot.js';
import { ApprovalCard } from './ApprovalCard.js';
import {
  type AttentionDecision,
  attentionKey,
  attentionOpen,
  canAlwaysAllow,
  decideApproval,
  type InboxItem,
  inboxItems,
  inboxTarget,
  lingerFor,
  openInboxItem,
  selectWaitingWithoutApproval,
} from './attention.js';
import { InboxControls } from './InboxControls.js';

const close = () => attentionOpen.set('closed');

/**
 * The right sheet listing everything that waits for the user across projects, oldest first,
 * DESIGN.md §4.5a: approval cards and sessions to answer in place. Keyboard first: A, ⇧A, D, ↑↓
 * or J/K, Enter. On phones the same list is the Attention tab (`AttentionPage`).
 */
export function AttentionCenter() {
  const open = usePreference(attentionOpen) === 'open';
  // Reduced cross-fades in place; Off mounts the sheet already at rest.
  const level = useMotionLevel();
  const still = level !== 'full';
  const offscreen = move(still, 'translateX(100%)');
  return (
    <AnimatePresence>
      {open && (
        // The scrim sets the sheet apart from the pods it covers; a click on it closes the sheet.
        <motion.div
          key="attention-scrim"
          aria-hidden
          data-attention-scrim
          onClick={close}
          initial={level === 'off' ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: dur.base, ease: ease.out } }}
          exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
          className="fixed inset-x-0 top-12 bottom-0 z-40 bg-bg-0/50"
        />
      )}
      {open && (
        <motion.aside
          key="attention"
          aria-labelledby="attention-title"
          initial={level === 'off' ? false : { transform: offscreen, opacity: 0 }}
          animate={{ transform: 'none', opacity: 1, transition: spring.smooth }}
          exit={{
            transform: offscreen,
            opacity: 0,
            transition: { duration: dur.fast, ease: ease.out },
          }}
          className="fixed top-12 right-0 bottom-0 z-40 flex w-96 flex-col border-line border-l bg-bg-1 shadow-raised"
        >
          <SheetBody onClose={close} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** The phone's Attention tab: the sheet's list as a full screen; Esc goes to the overview. */
export function AttentionPage() {
  const [, navigate] = useLocation();
  return (
    <section
      aria-labelledby="attention-title"
      data-attention-page=""
      className="flex min-h-full flex-col bg-bg-1"
    >
      <SheetBody onClose={() => navigate(routes.overview)} inline />
    </section>
  );
}

/**
 * A deep link to one item, from a notification: the overview, with the inbox open over it on that
 * item. On a phone the shell turns that into the Attention tab, so Back goes to the overview.
 */
export function AttentionItemLink({ item }: { item: string }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate(routes.overview, { replace: true });
    openInboxItem(item);
  }, [item, navigate]);
  return null;
}

function SheetBody({ onClose, inline = false }: { onClose: () => void; inline?: boolean }) {
  const pending = useBoardList(selectPendingApprovals);
  const others = useBoardList(selectWaitingWithoutApproval);
  const client = useBoardClient();
  const store = useBoardStore();
  const level = useMotionLevel();
  const [, navigate] = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const lingering = useLingering(pending, level);
  const target = useSyncExternalStore(inboxTarget.subscribe, inboxTarget.get, inboxTarget.get);

  const items = inboxItems(pending, others);
  // When the selected item leaves, the one that took its place is next; the last moves up.
  const place = useRef(0);
  const selected =
    items.find((item) => item.key === selectedKey) ??
    items[Math.min(place.current, items.length - 1)] ??
    null;
  place.current = selected ? items.indexOf(selected) : 0;
  const selectedApproval = selected?.kind === 'approval' ? selected.approval : null;

  // Decided cards linger with their outcome, in their place in the list.
  const rows: { key: string; item: InboxItem; since: number }[] = [
    ...items.map((item) => ({ key: item.key, item, since: item.since })),
    ...[...lingering.values()].map((approval) => ({
      key: approval.id,
      item: { kind: 'approval', key: approval.id, since: approval.createdAt, approval } as const,
      since: approval.createdAt,
    })),
  ].sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));

  const reveal = (key: string, focus: boolean) => {
    const row = list.current?.querySelector<HTMLElement>(`[data-inbox-item="${CSS.escape(key)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    if (focus) row?.focus({ preventScroll: true });
  };

  // A notification or a toast asked for this item; it may arrive after the sheet does.
  useEffect(() => {
    if (target === null || !items.some((item) => item.key === target)) return;
    setSelectedKey(target);
    setDenyingId(null);
    inboxTarget.set(null);
    reveal(target, false);
  });

  // After a decision the next item takes focus, so the keyboard carries straight on.
  const decided = useRef(false);
  const shownKey = selected?.key ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the selection moves
  useEffect(() => {
    if (!decided.current) return;
    decided.current = false;
    if (shownKey) {
      setSelectedKey(shownKey);
      reveal(shownKey, true);
    } else heading.current?.focus();
  }, [shownKey]);

  const decide = async (
    approval: Approval,
    decision: AttentionDecision,
    reason?: string,
    extra?: Parameters<typeof decideApproval>[4],
  ) => {
    if (busy.has(approval.id)) return;
    if (decision === 'allowAlways' && !canAlwaysAllow(approval)) return;
    setBusy((prev) => new Set(prev).add(approval.id));
    // Set first: the board's patch can beat the reply, and it's what moves the selection.
    decided.current = true;
    const ok = await decideApproval(client, approval.id, decision, reason, extra);
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(approval.id);
      return next;
    });
    if (ok) setDenyingId((id) => (id === approval.id ? null : id));
    else decided.current = false;
  };

  const open = (item: InboxItem) => {
    const session =
      item.kind === 'session'
        ? item.session
        : store.getState().board.sessions[item.approval.sessionId];
    if (!session?.projectId) return;
    close();
    navigate(sessionHref(session.projectId, session.id));
  };

  // The newest handlers for the window listener, which subscribes once.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  keys.current = (event) => {
    const key = attentionKey(event);
    if (!key || !selected) return;
    if (key.kind === 'open') {
      // A focused button or link answers Enter itself.
      if ((event.target as Element | null)?.closest?.('a, button')) return;
      event.preventDefault();
      open(selected);
    } else if (key.kind === 'move') {
      event.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, items.indexOf(selected) + key.by))];
      if (!next) return;
      setSelectedKey(next.key);
      setDenyingId(null);
      reveal(next.key, false);
    } else if (selectedApproval) {
      event.preventDefault();
      if (key.decision === 'deny') setDenyingId(selectedApproval.id);
      else void decide(selectedApproval, key.decision);
    }
  };

  useEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      keys.current(event);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const count = items.length;
  return (
    <>
      <header
        className={cx(
          'flex h-12 shrink-0 items-center gap-2 border-line border-b',
          inline ? 'px-4' : 'pr-2 pl-5',
        )}
      >
        <h2
          id="attention-title"
          ref={heading}
          tabIndex={-1}
          className="flex-1 text-body text-text-1 outline-none"
        >
          Needs you
          <NumberTicker value={count} className="ml-2 text-text-2" />
        </h2>
        {!inline && (
          <IconButton
            label="Close"
            shortcut="Escape"
            size="sm"
            tooltipSide="left"
            onClick={onClose}
            icon={<X className="size-4" strokeWidth={1.5} />}
          />
        )}
      </header>
      {rows.length === 0 ? (
        // Fades in so it doesn't pop in the frame the last decided card leaves.
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: dur.base, ease: ease.out }}
          className="px-5 py-8 text-center text-body-sm text-text-2"
        >
          Nothing is waiting for you.
        </motion.p>
      ) : (
        <div className="flex min-h-0 flex-col overflow-y-auto">
          <ul ref={list} aria-label="Waiting" className="relative flex flex-col gap-2 p-2">
            <AnimatePresence initial={false} mode="popLayout">
              {rows.map(({ key, item }) => {
                const resolved = lingering.has(key);
                const isSelected = !resolved && key === selected?.key;
                return (
                  <motion.li
                    key={key}
                    layout="position"
                    tabIndex={-1}
                    data-inbox-item={key}
                    // y and scale (not a transform string) compose with the layout slide.
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    // A decided card has already said how it ended: it just fades.
                    exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                    transition={spring.smooth}
                  >
                    {item.kind === 'approval' ? (
                      <ApprovalCard
                        approval={item.approval}
                        resolved={resolved ? (lingering.get(key)?.state ?? 'expired') : null}
                        selected={isSelected}
                        denying={!resolved && key === denyingId}
                        busy={busy.has(key)}
                        onSelect={() => !resolved && setSelectedKey(key)}
                        onDecide={(decision, reason) =>
                          void decide(item.approval, decision, reason)
                        }
                        onDenyStart={() => {
                          setSelectedKey(key);
                          setDenyingId(key);
                        }}
                        onDenyCancel={() => {
                          setDenyingId(null);
                          heading.current?.focus();
                        }}
                        inbox={{
                          onOpen: close,
                          onStopRequest: () =>
                            void decide(item.approval, 'deny', undefined, { interrupt: true }),
                          onAllowWithMode: (mode) =>
                            void decide(item.approval, 'allow', undefined, { mode }),
                        }}
                      />
                    ) : (
                      <WaitingItem
                        session={item.session}
                        selected={isSelected}
                        onSelect={() => setSelectedKey(key)}
                      />
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * Approvals that just left the pending list, kept with their final state for as long as their
 * outcome plays (`lingerFor`). Removed approvals count as expired.
 */
function useLingering(
  pending: readonly Approval[],
  level: MotionLevel,
): ReadonlyMap<string, Approval> {
  const store = useBoardStore();
  const [lingering, setLingering] = useState<ReadonlyMap<string, Approval>>(new Map());
  const previous = useRef<readonly Approval[]>(pending);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const ids = new Set(pending.map((a) => a.id));
    const left = previous.current.filter((a) => !ids.has(a.id));
    previous.current = pending;
    const approvals = store.getState().board.approvals;
    const done = left
      .map((a) => approvals[a.id] ?? { ...a, state: 'expired' as const })
      .filter((a) => lingerFor(a.state, level) > 0);
    if (done.length === 0) return;
    setLingering((prev) => new Map([...prev, ...done.map((a) => [a.id, a] as const)]));
    for (const approval of done) {
      const timer = setTimeout(
        () => {
          timers.current.delete(timer);
          setLingering((prev) => {
            const next = new Map(prev);
            next.delete(approval.id);
            return next;
          });
        },
        lingerFor(approval.state, level),
      );
      timers.current.add(timer);
    }
  }, [pending, level, store]);

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const timer of all) clearTimeout(timer);
    };
  }, []);

  return lingering;
}

/** A session to answer in place: a reply is due, or it asks in its terminal. */
function WaitingItem({
  session,
  selected,
  onSelect,
}: {
  session: ClaudeSession;
  selected: boolean;
  onSelect(): void;
}) {
  const project = useBoard(selectProject(session.projectId ?? ''));
  const caption = sessionCaption(session, null);
  const title = sessionDisplayName(session);
  const subtitle = sessionSubtitle(session);
  const summary = sessionSummary(session);
  const now = useNow(STALE_TICK_MS);
  const href = project ? sessionHref(project.id, session.id) : null;
  const body = (
    <>
      {project && <ProjectAvatar project={project} />}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Name and title shrink in proportion, so a long project name can't hide the title. */}
        <span className="flex min-w-0 text-body-sm">
          <span className="min-w-0 truncate text-text-1" title={project?.name}>
            {project?.name ?? 'No project'}
          </span>
          {title && (
            <span className="min-w-0 truncate text-text-2" title={subtitle ?? title}>
              <span aria-hidden>&nbsp;·&nbsp;</span>
              {title}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusDot
            tone="wait"
            label={caption.text}
            showLabel
            className="min-w-0 text-label text-st-wait-ink"
          />
          <span data-waited className="shrink-0 text-label text-text-3">
            {formatWaited(Math.max(0, now - session.updatedAt))}
          </span>
        </span>
        {summary && (
          <span data-summary title={summary} className="truncate text-meta text-text-2">
            {summary}
          </span>
        )}
      </span>
    </>
  );
  const row = 'flex items-start gap-3 rounded-control';
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: selection follows the inbox's own keys
    // biome-ignore lint/a11y/noStaticElementInteractions: the link and controls inside are the targets
    <div
      data-waiting={session.id}
      data-selected={selected || undefined}
      aria-current={selected || undefined}
      onClick={onSelect}
      className={cx(
        'flex cursor-pointer flex-col gap-2 rounded-panel border p-3',
        selected ? 'border-line-strong bg-bg-2' : 'border-line bg-bg-1',
      )}
    >
      {href ? (
        <Link href={href} onClick={close} className={row}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
      <InboxControls
        session={session}
        approval={null}
        busy={false}
        selected={selected}
        onOpen={close}
      />
    </div>
  );
}

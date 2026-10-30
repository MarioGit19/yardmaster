import {
  type Approval,
  type ClaudeSession,
  sessionDisplayName,
  sessionSubtitle,
} from '@yardmaster/protocol';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  selectPendingApprovals,
  selectProject,
  useBoard,
  useBoardClient,
  useBoardList,
  useBoardStore,
} from '../data/index.js';
import { dur, ease, type MotionLevel, move, spring, useMotionLevel } from '../motion.js';
import { sessionCaption } from '../pod/model.js';
import { usePreference } from '../prefs.js';
import { routes, sessionHref } from '../routes.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { isTypingTarget } from '../shell/railNav.js';
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
  lingerFor,
  selectWaitingWithoutApproval,
} from './attention.js';

const close = () => attentionOpen.set('closed');

/**
 * The right sheet listing everything that waits for the user, DESIGN.md §4.5: approval cards
 * (keyboard first: A, ⇧A, D, ↑↓), then sessions to answer elsewhere. On phones the same list is
 * the Attention tab (`AttentionPage`).
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

function SheetBody({ onClose, inline = false }: { onClose: () => void; inline?: boolean }) {
  const pending = useBoardList(selectPendingApprovals);
  const others = useBoardList(selectWaitingWithoutApproval);
  const client = useBoardClient();
  const level = useMotionLevel();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const lingering = useLingering(pending, level);

  const cards = [...pending, ...lingering.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const selected = pending.find((a) => a.id === selectedId) ?? pending[0] ?? null;

  const decide = async (approval: Approval, decision: AttentionDecision, reason?: string) => {
    if (busy.has(approval.id)) return;
    if (decision === 'allowAlways' && !canAlwaysAllow(approval)) return;
    setBusy((prev) => new Set(prev).add(approval.id));
    const ok = await decideApproval(client, approval.id, decision, reason);
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(approval.id);
      return next;
    });
    if (ok) setDenyingId((id) => (id === approval.id ? null : id));
  };

  // The newest handlers for the window listener, which subscribes once.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  keys.current = (event) => {
    const key = attentionKey(event);
    if (!key || !selected) return;
    event.preventDefault();
    if (key.kind === 'move') {
      const index = pending.indexOf(selected);
      const next = pending[Math.max(0, Math.min(pending.length - 1, index + key.by))];
      if (!next) return;
      setSelectedId(next.id);
      setDenyingId(null);
      list.current
        ?.querySelector(`[data-approval="${CSS.escape(next.id)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    } else if (key.decision === 'deny') {
      setDenyingId(selected.id);
    } else {
      void decide(selected, key.decision);
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

  const count = pending.length + others.length;
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
      {count === 0 && cards.length === 0 ? (
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
          {cards.length > 0 && (
            <ul ref={list} aria-label="Approvals" className="relative flex flex-col gap-2 p-2">
              <AnimatePresence initial={false} mode="popLayout">
                {cards.map((approval) => {
                  const resolved = lingering.has(approval.id);
                  return (
                    <motion.li
                      key={approval.id}
                      layout="position"
                      // y and scale (not a transform string) compose with the layout slide.
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      // A decided card has already said how it ended: it just fades.
                      exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                      transition={spring.smooth}
                    >
                      <ApprovalCard
                        approval={approval}
                        resolved={
                          resolved ? (lingering.get(approval.id)?.state ?? 'expired') : null
                        }
                        selected={!resolved && approval.id === selected?.id}
                        denying={!resolved && approval.id === denyingId}
                        busy={busy.has(approval.id)}
                        onSelect={() => !resolved && setSelectedId(approval.id)}
                        onDecide={(decision, reason) => void decide(approval, decision, reason)}
                        onDenyStart={() => {
                          setSelectedId(approval.id);
                          setDenyingId(approval.id);
                        }}
                        onDenyCancel={() => {
                          setDenyingId(null);
                          heading.current?.focus();
                        }}
                      />
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
          {others.length > 0 && (
            <section aria-labelledby="attention-others" className="flex flex-col p-2 pt-1">
              <h3 id="attention-others" className="px-3 pt-2 pb-1 text-meta text-text-2">
                Answer in the session
              </h3>
              <ul className="flex flex-col gap-1">
                {others.map((session) => (
                  <WaitingItem key={session.id} session={session} />
                ))}
              </ul>
            </section>
          )}
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

function WaitingItem({ session }: { session: ClaudeSession }) {
  const project = useBoard(selectProject(session.projectId ?? ''));
  const caption = sessionCaption(session, null);
  const title = sessionDisplayName(session);
  const subtitle = sessionSubtitle(session);
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
        <StatusDot
          tone="wait"
          label={caption.text}
          showLabel
          className="text-label text-st-wait-ink"
        />
      </span>
    </>
  );
  const row = 'flex items-start gap-3 rounded-control px-3 py-2';
  return (
    <li data-waiting={session.id}>
      {href ? (
        <Link href={href} onClick={close} className={`${row} hover:bg-bg-2`}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

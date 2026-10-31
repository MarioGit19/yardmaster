import * as Dialog from '@radix-ui/react-dialog';
import { redact } from '@yardmaster/protocol';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { useNow } from '../anim/clock.js';
import { attentionOpen } from '../attention/attention.js';
import { useBoard, useBoardStore } from '../data/index.js';
import { dur, ease, slide, spring, useMotionLevel } from '../motion.js';
import { countOf } from '../plural.js';
import { useMediaQuery } from '../prefs.js';
import { useRedactOn } from '../redact/reveal.js';
import { seenItems, useSeenItems } from '../seen.js';
import { NARROW_QUERY } from '../shell/prefs.js';
import { isTypingTarget } from '../shell/railNav.js';
import type { Tone } from '../status.js';
import { STALE_TICK_MS } from '../statusTokens.js';
import { formatClock, formatDateTime, formatWaited } from '../time.js';
import { SheetPanel } from '../ui/BottomSheet.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { IconButton } from '../ui/IconButton.js';
import { StatusDot } from '../ui/StatusDot.js';
import { createAwayClock, recapAfterPreference } from './away.js';
import {
  hasNews,
  isEmptyRecap,
  RECAP_ORDER,
  type Recap,
  type RecapItem,
  type RecapSection,
  selectDotMarks,
  selectRecap,
} from './model.js';
import { useFailureTail } from './useFailureTail.js';

/** How long after a return a reconnecting board gets to catch up with what it missed. */
const CATCH_UP_MS = 5_000;
/** Pointer moves are checked this often at most. */
const ACTIVITY_MS = 1_000;
/** Failed commands whose output the recap streams; the rest show their exit code. */
const TAILS = 4;

const SECTION: Record<RecapSection, { title: string; tone: Tone }> = {
  needs_you: { title: 'Needs you', tone: 'wait' },
  failed: { title: 'Failed', tone: 'err' },
  finished: { title: 'Finished', tone: 'ok' },
  running: { title: 'Still running', tone: 'work' },
};

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const awayClock = createAwayClock(storage(), () => {
  const after = recapAfterPreference.get();
  return after === 'off' ? null : Number(after) * 60_000;
});

/** Calls back with when the user was last here, each time they return after long enough. */
function useAwayReturn(onReturn: (from: number) => void) {
  const callback = useRef(onReturn);
  callback.current = onReturn;
  useEffect(() => {
    const check = () => {
      const from = awayClock.touch();
      if (from !== null) callback.current(from);
    };
    let checkedAt = 0;
    const onActivity = () => {
      const at = Date.now();
      if (at - checkedAt < ACTIVITY_MS || document.visibilityState !== 'visible') return;
      checkedAt = at;
      check();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
      else awayClock.flush();
    };
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    if (document.visibilityState === 'visible') check();
    for (const event of events) window.addEventListener(event, onActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', awayClock.flush);
    return () => {
      for (const event of events) window.removeEventListener(event, onActivity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', awayClock.flush);
    };
  }, []);
}

/**
 * Decides when to show the recap: on a return after long enough, if something happened meanwhile.
 * A phone returns only by opening the app; a desktop board also by being touched after sitting idle.
 */
export function RecapHost() {
  const seen = useSeenItems();
  const [returned, setReturned] = useState<{ from: number; at: number } | null>(null);
  const [shownFrom, setShownFrom] = useState<number | null>(null);
  useAwayReturn((from) => setReturned((prev) => prev ?? { from, at: Date.now() }));

  const ready = useBoard((s) => s.hydrated && s.connection.status === 'live') && seenItems.loaded();
  const news = useBoard(
    (s) =>
      ready &&
      returned !== null &&
      hasNews(selectRecap(seen, returned.from, returned.at)(s), returned.from, returned.at),
  );

  useEffect(() => {
    if (!returned || !ready) return;
    if (news) {
      setShownFrom((prev) => prev ?? returned.from);
      setReturned(null);
      return;
    }
    const timer = setTimeout(() => setReturned(null), CATCH_UP_MS);
    return () => clearTimeout(timer);
  }, [returned, ready, news]);

  return <RecapSurface from={shownFrom} onClose={() => setShownFrom(null)} />;
}

function RecapSurface({ from, onClose }: { from: number | null; onClose(): void }) {
  const phone = useMediaQuery(NARROW_QUERY);
  const level = useMotionLevel();
  if (phone) {
    return (
      <Dialog.Root open={from !== null} onOpenChange={(next) => !next && onClose()}>
        <AnimatePresence>
          {from !== null && (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  className="palette-overlay fixed inset-0 z-50"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: dur.fast, ease: ease.out } }}
                  exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                />
              </Dialog.Overlay>
              <Dialog.Content asChild forceMount aria-describedby={undefined}>
                <SheetPanel data-recap="" onDismiss={onClose}>
                  <RecapBody
                    from={from}
                    onClose={onClose}
                    title={(text) => (
                      <Dialog.Title className="text-body text-text-1">{text}</Dialog.Title>
                    )}
                  />
                </SheetPanel>
              </Dialog.Content>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
    );
  }
  // Beside the work, not over it, and it takes no focus: the user may already be typing.
  const hidden = slide(level !== 'full', '8px');
  return (
    <AnimatePresence>
      {from !== null && (
        <motion.aside
          key="recap"
          data-recap=""
          aria-labelledby="recap-title"
          initial={level === 'off' ? false : { transform: hidden, opacity: 0 }}
          animate={{ transform: 'none', opacity: 1, transition: spring.smooth }}
          exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
          className="palette fixed top-14 right-4 z-40 flex max-h-[calc(100dvh-5rem-var(--pulse-h,0px))] w-[min(28rem,calc(100vw-32px))] flex-col overflow-hidden rounded-panel border border-line-strong shadow-raised"
        >
          <RecapBody
            from={from}
            onClose={onClose}
            title={(text) => (
              <h2 id="recap-title" className="text-body text-text-1">
                {text}
              </h2>
            )}
            listensForEsc
          />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function useRecap(from: number): Recap {
  const seen = useSeenItems();
  const now = useNow(STALE_TICK_MS);
  const key = useBoard((s) => JSON.stringify(selectRecap(seen, from, now)(s)));
  return useMemo(() => JSON.parse(key) as Recap, [key]);
}

function RecapBody({
  from,
  onClose,
  title,
  listensForEsc = false,
}: {
  from: number;
  onClose(): void;
  title(text: string): ReactNode;
  /** Listens for Esc itself; a dialog already does. */
  listensForEsc?: boolean;
}) {
  const recap = useRecap(from);
  const store = useBoardStore();
  const seen = useSeenItems();
  const [opened] = useState(() => Date.now());
  const empty = isEmptyRecap(recap);
  const dots = Object.keys(selectDotMarks(seen, from, opened)(store.getState())).length;

  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);

  useEffect(() => {
    if (!listensForEsc) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
      if (attentionOpen.get() === 'open') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listensForEsc, onClose]);

  const markAll = () => {
    const marks = selectDotMarks(seen, from, Date.now())(store.getState());
    const undo = seenItems.markAll(marks);
    onClose();
    toast.success(`Marked ${countOf(Object.keys(marks).length, 'item')} seen`, {
      action: { label: 'Undo', onClick: undo },
    });
  };

  let tails = TAILS;
  return (
    <>
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-line border-b pr-2 pl-4">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          {title('While you were away')}
          <span className="truncate text-label text-text-2" title={formatDateTime(from)}>
            since {formatClock(from, opened)}
          </span>
        </div>
        {listensForEsc && (
          <IconButton
            label="Dismiss"
            shortcut="Escape"
            size="sm"
            tooltipSide="left"
            onClick={onClose}
            icon={<X className="size-4" strokeWidth={1.5} />}
          />
        )}
      </header>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-2">
        {RECAP_ORDER.map((section) => {
          const items = recap[section];
          if (items.length === 0) return null;
          const { title: heading, tone } = SECTION[section];
          return (
            <section key={section} data-recap-section={section} aria-label={heading}>
              <h3 className="flex items-center gap-2 px-2 py-1 text-label text-text-2">
                <StatusDot tone={tone} label={heading} showLabel />
                <span className="tabular-nums">{items.length}</span>
              </h3>
              <ul>
                {items.map((item) => (
                  <li key={item.key}>
                    <RecapRow
                      item={item}
                      tail={section === 'failed' && tails-- > 0}
                      onOpen={onClose}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-line border-t p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:pb-2">
        <Button variant="ghost" size="sm" data-recap-dismiss="" onClick={onClose}>
          Dismiss
        </Button>
        {dots > 0 && (
          <Button size="sm" data-recap-mark-all="" onClick={markAll}>
            Mark all seen
          </Button>
        )}
      </footer>
    </>
  );
}

function RecapRow({ item, tail, onOpen }: { item: RecapItem; tail: boolean; onOpen(): void }) {
  const redactOn = useRedactOn();
  const now = useNow(STALE_TICK_MS);
  const lines = useFailureTail(tail ? item.execId : null);
  const detail = redactOn ? redact(item.detail) : item.detail;
  const failed = item.section === 'failed';
  const timed = item.section !== 'running';
  const row = 'flex min-w-0 flex-col rounded-control px-2 py-1.5 touch:min-h-11';
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-2 text-body-sm">
        <span className="min-w-0 truncate font-medium text-text-1">{item.project}</span>
        <span className="min-w-0 flex-1 truncate text-text-2">{item.name}</span>
        {timed && (
          <span
            className="shrink-0 text-meta text-text-2 tabular-nums"
            title={formatDateTime(item.at)}
          >
            {formatWaited(Math.max(0, now - item.at))}
          </span>
        )}
      </span>
      <span
        title={detail}
        className={cx('truncate text-label', failed ? 'text-st-err-ink' : 'text-text-2')}
      >
        {detail}
      </span>
      {lines.length > 0 && (
        <span
          data-recap-tail=""
          className="mt-1 block overflow-hidden rounded-control bg-bg-2 px-2 py-1 font-mono text-meta text-text-2"
        >
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: output lines repeat and never reorder
            <span key={index} className="block truncate">
              {line}
            </span>
          ))}
        </span>
      )}
      {item.filesChanged !== null && item.filesChanged > 0 && (
        <span data-recap-files="" className="text-meta text-text-2">
          {countOf(item.filesChanged, 'file')} changed in the project
        </span>
      )}
    </>
  );
  return item.href ? (
    <Link
      href={item.href}
      onClick={onOpen}
      data-recap-item={item.key}
      className={cx(row, 'hover:bg-bg-2')}
    >
      {body}
    </Link>
  ) : (
    <div data-recap-item={item.key} className={row}>
      {body}
    </div>
  );
}

import { AnimatePresence, motion } from 'motion/react';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { useNow } from '../anim/clock.js';
import { useBoard, useBoardClient } from '../data/index.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { useSeenItems } from '../seen.js';
import { STALE_TICK_MS } from '../statusTokens.js';
import { actionErrorText } from '../terminal/stack.js';
import { formatDateTime, formatWaited } from '../time.js';
import { Button, buttonClass } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { decideApproval } from './attention.js';
import { STRIP_ROWS, type StripItem, selectStripItems } from './needsYou.js';

/** The strip's items; re-renders only when one of them changes. */
function useStripItems(): StripItem[] {
  const seen = useSeenItems();
  const now = useNow(STALE_TICK_MS);
  const key = useBoard((s) => JSON.stringify(selectStripItems(seen, now)(s)));
  return useMemo(() => JSON.parse(key) as StripItem[], [key]);
}

const [x1, y1, x2, y2] = ease.out;

/**
 * The strip pushes the overview down as it grows, so the overview glides there by transform
 * instead of landing under the pointer.
 */
function useGlideBelow(strip: RefObject<HTMLElement | null>, below: RefObject<HTMLElement | null>) {
  const level = useMotionLevel();
  useEffect(() => {
    const element = strip.current;
    if (!element || typeof ResizeObserver === 'undefined' || level !== 'full') return;
    let height = element.offsetHeight;
    const observer = new ResizeObserver(() => {
      const next = element.offsetHeight;
      const by = height - next;
      height = next;
      if (by === 0) return;
      // motion-still: the effect only subscribes at Full.
      below.current?.animate([{ transform: `translateY(${by}px)` }, { transform: 'none' }], {
        duration: dur.base * 1000,
        easing: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [strip, below, level]);
}

/**
 * Everything waiting on the user, above the overview in every layout (DESIGN.md §4.5b): oldest
 * first, three rows and the rest behind "+N more". Empty, it takes no space at all. It only sticks
 * in a tall window: on a short one it would cover what it sits above.
 */
export function NeedsYouStrip({ below }: { below: RefObject<HTMLElement | null> }) {
  const items = useStripItems();
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useGlideBelow(ref, below);
  const folded = items.length - STRIP_ROWS;
  const shown = expanded ? items : items.slice(0, STRIP_ROWS);
  return (
    <section
      ref={ref}
      aria-label="Needs you"
      data-needs-you={items.length}
      className="@container z-30 md:[@media(min-height:720px)]:sticky md:top-2"
    >
      {items.length > 0 && (
        <div className="mb-4 flex flex-col overflow-hidden rounded-panel border border-line-strong bg-bg-1 shadow-raised">
          <ul className="flex flex-col divide-y divide-line">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((item) => (
                <motion.li
                  key={item.key}
                  layout="position"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
                  transition={spring.smooth}
                  data-strip-item={item.key}
                  data-strip-token={item.token}
                >
                  <StripRow item={item} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {folded > 0 && (
            <button
              type="button"
              data-strip-more=""
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              className="h-8 w-full border-line border-t px-4 text-left text-label text-text-2 transition-colors duration-fast ease-out hover:bg-bg-2 hover:text-text-1 touch:h-11"
            >
              {expanded ? 'Show less' : `+${folded} more`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function StripRow({ item }: { item: StripItem }) {
  const now = useNow(STALE_TICK_MS);
  const waited = formatWaited(Math.max(0, now - item.since));
  const failed = item.token === 'failed';
  const body = (
    <>
      <StatusDot tone={failed ? 'err' : 'wait'} label={failed ? 'Failed' : 'Needs you'} />
      <span className="flex min-w-0 flex-1 flex-col @min-[44rem]:flex-row @min-[44rem]:items-baseline @min-[44rem]:gap-3">
        <span className="flex min-w-0 shrink-0 text-body-sm @min-[44rem]:max-w-[40%]">
          <span className="min-w-0 truncate font-medium text-text-1">{item.project}</span>
          <span className="min-w-0 truncate text-text-2">
            <span aria-hidden>&nbsp;·&nbsp;</span>
            {item.name}
          </span>
        </span>
        <span
          className={cx(
            'min-w-0 flex-1 truncate text-body-sm',
            failed ? 'text-st-err-ink' : 'text-st-wait-ink',
          )}
          title={item.reason}
        >
          {item.reason}
        </span>
      </span>
      <span
        className="shrink-0 text-meta text-text-2 tabular-nums"
        title={formatDateTime(item.since)}
      >
        {waited}
      </span>
    </>
  );
  const row = 'flex min-h-11 min-w-0 flex-1 items-center gap-3 py-1.5 pr-1 pl-4';
  return (
    <div className="flex min-w-0 flex-col @min-[36rem]:flex-row @min-[36rem]:items-center">
      {item.href ? (
        <Link href={item.href} data-strip-open="" className={cx(row, 'hover:bg-bg-2')}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
      <div className="flex shrink-0 items-center justify-end gap-1.5 px-3 pb-2 @min-[36rem]:pb-0">
        <StripAction item={item} />
      </div>
    </div>
  );
}

function StripAction({ item }: { item: StripItem }) {
  const client = useBoardClient();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  const { approvalId, rerun, href } = item;
  if (approvalId) {
    const decide = (decision: 'allow' | 'deny') =>
      run(() => decideApproval(client, approvalId, decision));
    return (
      <>
        <Button
          variant="primary"
          size="sm"
          data-strip-approve=""
          disabled={busy}
          aria-label={`Approve ${item.reason} in ${item.project}`}
          onClick={() => void decide('allow')}
        >
          Approve
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-strip-deny=""
          disabled={busy}
          aria-label={`Deny ${item.reason} in ${item.project}`}
          onClick={() => void decide('deny')}
        >
          Deny
        </Button>
      </>
    );
  }
  if (rerun) {
    return (
      <Button
        size="sm"
        data-strip-rerun=""
        disabled={busy}
        title={`Re-run ${rerun.command}`}
        onClick={() =>
          void run(async () => {
            const result = await client.action({ kind: 'terminal.rerun', execId: rerun.execId });
            if (!result.ok) toast.error(actionErrorText(result.error));
          })
        }
      >
        Rerun
      </Button>
    );
  }
  return href ? (
    <Link
      href={href}
      data-strip-action-open=""
      aria-label={`Open ${item.name} in ${item.project}`}
      className={buttonClass('secondary', 'sm')}
    >
      Open
    </Link>
  ) : null;
}

import type { ClaudeSession } from '@yardmaster/protocol';
import { redact } from '@yardmaster/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { useLocation } from 'wouter';
import { dur, ease } from '../motion.js';
import { useRedactOn } from '../redact/reveal.js';
import { sessionHref } from '../routes.js';
import { cx } from '../ui/cx.js';
import { backgroundItems, backgroundLine } from './model.js';
import { backgroundOpen } from './open.js';

/** A small ring that turns while background work runs; still at Reduced. */
export function BackgroundSpinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        'hud-spin inline-block size-2 shrink-0 rounded-full border border-st-work border-t-transparent',
        className,
      )}
    />
  );
}

/**
 * A session row's line for work running beside the turn: `2 running: Typecheck watcher ·
 * Explore: find discount rules`. It opens the session with its Background list showing.
 */
export function BackgroundLine({
  session,
  className,
}: {
  session: ClaudeSession;
  className?: string;
}) {
  const [, navigate] = useLocation();
  const redactOn = useRedactOn();
  const line = backgroundLine(backgroundItems(session));
  const text = line !== null && redactOn ? redact(line) : line;
  return (
    <AnimatePresence initial={false}>
      {text !== null && (
        <motion.button
          key="line"
          type="button"
          data-background-line={session.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
          transition={{ duration: dur.base, ease: ease.out }}
          onClick={() => {
            backgroundOpen.request(session.id);
            if (session.projectId) navigate(sessionHref(session.projectId, session.id));
          }}
          title={text}
          aria-label={`In the background: ${text}. Show the list`}
          className={cx(
            'flex min-w-0 max-w-full items-center gap-1.5 rounded-chip text-left text-meta text-text-2 transition-colors duration-fast hover:text-text-1 touch:min-h-11',
            className,
          )}
        >
          <BackgroundSpinner />
          <span className="truncate">{text}</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}

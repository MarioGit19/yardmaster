import { AnimatePresence, motion } from 'motion/react';
import { dur, ease } from '../motion.js';
import { cx } from '../ui/cx.js';
import { useHasDraft } from './drafts.js';

/** "Draft" beside a session or terminal that has unsent text in its composer (text, not colour). */
export function DraftMarker({ draft, className }: { draft: string | null; className?: string }) {
  const has = useHasDraft(draft);
  return (
    <AnimatePresence initial={false}>
      {has && (
        <motion.span
          data-draft-marker
          title="Unsent draft"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: dur.fast, ease: ease.out }}
          className={cx(
            'inline-flex h-4 shrink-0 items-center rounded-chip border border-line px-1 text-meta text-text-2 leading-none',
            className,
          )}
        >
          Draft
        </motion.span>
      )}
    </AnimatePresence>
  );
}

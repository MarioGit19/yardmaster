import { Check, X } from 'lucide-react';
import { motion } from 'motion/react';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { cx } from './cx.js';

/**
 * An exit status that pops in (DESIGN.md §4.10): a quiet check for 0, a rose chip otherwise.
 * Key it by the execution inside `AnimatePresence` so each new exit pops again.
 */
export function ExitBadge({ code, className }: { code: number; className?: string }) {
  const label = code === 0 ? 'Exited 0' : `Exit code ${code}`;
  // Reduced fades in place.
  const from = useMotionLevel() === 'full' ? 'scale(0.9)' : 'none';
  return (
    <motion.span
      role="img"
      aria-label={label}
      title={label}
      data-exit={code}
      initial={{ opacity: 0, transform: from }}
      animate={{ opacity: 1, transform: 'none' }}
      exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
      transition={spring.snappy}
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-0.5 rounded-chip px-1 font-mono text-meta tabular',
        code === 0 ? 'text-st-ok' : 'bg-st-err-glow text-st-err',
        className,
      )}
    >
      {code === 0 ? (
        <Check aria-hidden className="size-3" strokeWidth={2.25} />
      ) : (
        <X aria-hidden className="size-3" strokeWidth={2.25} />
      )}
      {code}
    </motion.span>
  );
}

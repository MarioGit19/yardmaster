import { Check, X } from 'lucide-react';
import { motion } from 'motion/react';
import { dur, ease, move, spring, useMotionLevel } from '../motion.js';
import { cx } from './cx.js';

/**
 * An exit status that pops in (DESIGN.md §4.10): a quiet check for 0, a rose chip otherwise.
 * Key it by the execution inside `AnimatePresence` so each new exit pops again.
 */
export function ExitBadge({ code, className }: { code: number; className?: string }) {
  const label = code === 0 ? 'Exited 0' : `Exit code ${code}`;
  // Reduced fades in place.
  const still = useMotionLevel() !== 'full';
  return (
    <motion.span
      role="img"
      aria-label={label}
      title={label}
      data-exit={code}
      initial={{ opacity: 0, transform: move(still, 'scale(0.9)') }}
      // Spring to scale(1) and drop the transform at rest. Springing straight to `'none'` left a
      // zero matrix that collapsed the badge.
      animate={{
        opacity: 1,
        transform: move(still, 'scale(1)'),
        transitionEnd: { transform: 'none' },
      }}
      exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
      transition={spring.snappy}
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-0.5 rounded-chip px-1 font-mono text-meta tabular',
        code === 0 ? 'text-st-ok-ink' : 'bg-st-err-glow text-st-err-ink',
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

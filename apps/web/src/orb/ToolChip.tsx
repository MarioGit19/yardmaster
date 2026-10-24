import { type ToolFamily, toolFamily } from '@yardmaster/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { dur, ease, move, spring, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';
import { FAMILY_TOKEN } from './model.js';

/** The chip's slide as a transform string (compositor-only); Reduced fades it in place. */
const chipShift = (moving: boolean, px: number) => move(!moving, `translateX(${px}px)`);

/**
 * The running tool's name in a small chip edged in its family color, DESIGN.md §4.2. It slides
 * out (and back in) as the tool changes; `null` hides it.
 */
export function ToolChip({
  tool,
  family,
  className,
}: {
  tool: string | null;
  family?: ToolFamily;
  className?: string;
}) {
  const moving = useMotionLevel() === 'full';
  const token = tool ? FAMILY_TOKEN[family ?? toolFamily(tool)] : null;
  return (
    <AnimatePresence initial={false}>
      {tool && (
        <motion.span
          key={tool}
          aria-hidden
          data-tool-chip={tool}
          initial={{ opacity: 0, transform: chipShift(moving, -4) }}
          animate={{ opacity: 1, transform: chipShift(moving, 0) }}
          exit={{
            opacity: 0,
            transform: chipShift(moving, -2),
            transition: { duration: dur.fast, ease: ease.out },
          }}
          transition={spring.snappy}
          className={cx(
            'pointer-events-none whitespace-nowrap rounded-chip border bg-bg-2 px-1.5 py-px font-mono text-meta text-text-2',
            className,
          )}
          style={{ borderColor: `color-mix(in srgb, var(${token}) 35%, transparent)` }}
        >
          {tool}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

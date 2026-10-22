import { motion } from 'motion/react';
import { spring, useMotionLevel } from '../motion.js';
import { cx } from './cx.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export interface NumberTickerProps {
  value: number;
  /** Text to show for the value, e.g. `formatCount`. Digits roll; other characters swap. */
  format?: (value: number) => string;
  className?: string;
}

/**
 * A rolling-digit counter (DESIGN.md §3.7). Each digit is a 0–9 strip moved by transform with a
 * spring, keyed from the right so units stay put as the number grows. Mounts without rolling.
 * Reduced swaps digits in place: a roll is movement.
 */
export function NumberTicker({ value, format = String, className }: NumberTickerProps) {
  const text = format(value);
  const chars = [...text];
  const still = useMotionLevel() !== 'full';
  return (
    <span className={cx('inline-flex tabular-nums', className)} data-value={value}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex">
        {chars.map((char, i) => {
          const place = chars.length - i;
          return /\d/.test(char) ? (
            <Digit key={place} digit={Number(char)} still={still} />
          ) : (
            <span key={`${place}${char}`}>{char}</span>
          );
        })}
      </span>
    </span>
  );
}

function Digit({ digit, still }: { digit: number; still: boolean }) {
  return (
    <span className="relative inline-block overflow-hidden">
      {/* Sizes the column: tabular digits all share this width. */}
      <span className="invisible">0</span>
      <motion.span
        className="absolute inset-x-0 top-0 flex flex-col"
        initial={false}
        // A full transform string stays on the compositor while the HUD ticks during streaming.
        animate={{ transform: `translateY(${-digit * 10}%)` }}
        transition={still ? { duration: 0 } : spring.smooth}
      >
        {DIGITS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </motion.span>
    </span>
  );
}

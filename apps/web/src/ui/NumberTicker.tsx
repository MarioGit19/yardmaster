import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useState } from 'react';
import { spring, useMotionLevel } from '../motion.js';
import { cx } from './cx.js';

/** Two turns of digits, so a roll can pass 9 → 0 (or 0 → 9) and keep going the same way. */
const STRIP = [...'01234567890123456789'];
const STEP = 100 / STRIP.length;

/**
 * Where a strip settles for `digit`, from its current position `pos` (0–20, the digit is
 * `pos % 10`), rolling forward when the value grew and down when it shrank. Returns the position to
 * jump to first (the same digit on the other turn, so the jump is invisible) and the target.
 */
export function rollTarget(pos: number, digit: number, dir: 1 | -1): { from: number; to: number } {
  if (dir > 0) {
    const from = pos >= 10 ? pos - 10 : pos;
    return { from, to: digit >= from - 0.5 ? digit : digit + 10 };
  }
  const from = pos < 10 ? pos + 10 : pos;
  return { from, to: digit + 10 <= from + 0.5 ? digit + 10 : digit };
}

export interface NumberTickerProps {
  value: number;
  /** Text to show for the value, e.g. `formatCount`. Digits roll; other characters swap. */
  format?: (value: number) => string;
  className?: string;
}

/**
 * A rolling-digit counter (DESIGN.md §3.7). Each digit is a strip moved by transform with a
 * spring, keyed from the right so units stay put as the number grows. Digits roll forward as the
 * value grows (9 → 0 carries on into the next turn) and down as it shrinks. Mounts without rolling.
 * Reduced swaps digits in place: a roll is movement.
 */
export function NumberTicker({ value, format = String, className }: NumberTickerProps) {
  // The direction of the latest change, kept until the value changes again.
  const [last, setLast] = useState<{ value: number; dir: 1 | -1 }>({ value, dir: 1 });
  const dir = last.value === value ? last.dir : value > last.value ? 1 : -1;
  if (last.value !== value) setLast({ value, dir });
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
            <Digit key={place} digit={Number(char)} dir={dir} still={still} />
          ) : (
            <span key={`${place}${char}`}>{char}</span>
          );
        })}
      </span>
    </span>
  );
}

function Digit({ digit, dir, still }: { digit: number; dir: 1 | -1; still: boolean }) {
  const pos = useMotionValue(digit);
  // A full transform string stays on the compositor while the HUD ticks during streaming.
  const transform = useTransform(pos, (p) => `translateY(${-p * STEP}%)`);

  useEffect(() => {
    if (still) {
      pos.jump(digit);
      return;
    }
    const { from, to } = rollTarget(pos.get(), digit, dir);
    if (from === to) return;
    pos.jump(from);
    // Rests on whichever turn it reached; the next change starts with the invisible jump.
    const roll = animate(pos, to, spring.smooth);
    return () => roll.stop();
  }, [digit, dir, still, pos]);

  return (
    <span className="relative inline-block overflow-hidden">
      {/* Sizes the column: tabular digits all share this width. */}
      <span className="invisible">0</span>
      <motion.span className="absolute inset-x-0 top-0 flex flex-col" style={{ transform }}>
        {STRIP.map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the strip is static.
          <span key={i}>{d}</span>
        ))}
      </motion.span>
    </span>
  );
}

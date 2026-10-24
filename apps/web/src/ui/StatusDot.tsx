import type { Tone } from '../status.js';
import { cx } from './cx.js';

/**
 * Each tone's mark has its own shape as well as its color (DESIGN.md §8), matching the Pulse
 * rail: waits are rings, errors are diamonds, finished/running is a square, idle is a small dot.
 * Literal classes so Tailwind's scanner picks them up.
 */
export const TONE_MARK: Record<Tone, string> = {
  work: 'size-2 rounded-full bg-st-work',
  tool: 'size-2 rounded-full bg-st-tool',
  wait: 'size-2 rounded-full border-[1.5px] border-st-wait',
  ok: 'size-[7px] rounded-none bg-st-ok',
  err: 'size-[7px] rotate-45 rounded-none bg-st-err',
  idle: 'size-1.5 rounded-full bg-st-idle',
};

const HALO: Record<Tone, string> = {
  work: 'shadow-[0_0_0_3px_var(--st-work-glow)]',
  tool: 'shadow-[0_0_0_3px_var(--st-tool-glow)]',
  wait: 'shadow-[0_0_0_3px_var(--st-wait-glow)]',
  ok: '',
  err: 'shadow-[0_0_0_3px_var(--st-err-glow)]',
  idle: '',
};

export interface StatusDotProps {
  tone: Tone;
  /** Visible text next to the dot. Without it, `label` becomes the accessible name. */
  label: string;
  showLabel?: boolean;
  className?: string;
}

/** Color, shape and text, so status never relies on color alone (DESIGN.md §8). */
export function StatusDot({ tone, label, showLabel = false, className }: StatusDotProps) {
  // A fixed 8px box keeps marks of every shape on one axis.
  const dot = (
    <span aria-hidden data-mark={tone} className="grid size-2 shrink-0 place-items-center">
      <span className={cx('block shrink-0', TONE_MARK[tone], HALO[tone])} />
    </span>
  );
  if (!showLabel) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-status={tone}
        className={cx('inline-flex', className)}
      >
        {dot}
      </span>
    );
  }
  return (
    <span data-status={tone} className={cx('inline-flex min-w-0 items-center gap-2', className)}>
      {dot}
      <span className="truncate">{label}</span>
    </span>
  );
}

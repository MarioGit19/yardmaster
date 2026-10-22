import type { Tone } from '../status.js';
import { cx } from './cx.js';

// Literal classes so Tailwind's scanner picks them up.
const DOT: Record<Tone, string> = {
  work: 'bg-st-work',
  tool: 'bg-st-tool',
  wait: 'bg-st-wait',
  ok: 'bg-st-ok',
  err: 'bg-st-err',
  idle: 'bg-st-idle',
};

const HALO: Record<Tone, string> = {
  work: 'shadow-[0_0_0_3px_var(--st-work-glow)]',
  tool: 'shadow-[0_0_0_3px_var(--st-tool-glow)]',
  wait: 'shadow-[0_0_0_3px_var(--st-wait-glow)]',
  ok: 'shadow-[0_0_0_3px_var(--st-ok-glow)]',
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

/** Color plus text, so status never relies on color alone (DESIGN.md §8). */
export function StatusDot({ tone, label, showLabel = false, className }: StatusDotProps) {
  const dot = (
    <span
      aria-hidden
      className={cx('inline-block size-2 shrink-0 rounded-full', DOT[tone], HALO[tone])}
    />
  );
  if (!showLabel) {
    return (
      <span role="img" aria-label={label} title={label} className={cx('inline-flex', className)}>
        {dot}
      </span>
    );
  }
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-2', className)}>
      {dot}
      <span className="truncate">{label}</span>
    </span>
  );
}

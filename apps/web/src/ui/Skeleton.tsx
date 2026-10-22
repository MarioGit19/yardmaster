import { cx } from './cx.js';

/** A shimmering placeholder block. Loading states use these, never spinners (DESIGN.md §6). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton rounded-chip bg-bg-2', className)} />;
}

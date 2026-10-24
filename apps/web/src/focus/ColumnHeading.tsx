import type { ReactNode } from 'react';
import { cx } from '../ui/cx.js';

/** A focus-view column title on a 28px row, so titles line up across columns with or without actions. */
export function ColumnHeading({
  children,
  meta,
  actions,
  className = 'mb-3',
}: {
  children: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex h-7 min-w-0 items-center gap-2', className)}>
      <h2
        data-column-heading
        className="flex min-w-0 flex-1 items-baseline gap-2 font-medium text-body text-text-1"
      >
        <span className="truncate">{children}</span>
        {meta !== undefined && <span className="tabular text-meta text-text-2">{meta}</span>}
      </h2>
      {actions}
    </div>
  );
}

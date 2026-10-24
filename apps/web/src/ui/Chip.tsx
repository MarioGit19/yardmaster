import type { ReactNode } from 'react';
import { cx } from './cx.js';

export interface ChipProps {
  children: ReactNode;
  icon?: ReactNode;
  mono?: boolean;
  title?: string;
  className?: string;
}

export function Chip({ children, icon, mono, title, className }: ChipProps) {
  return (
    <span
      title={title}
      data-chip
      className={cx(
        'inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-chip border border-line bg-bg-2 px-2 text-label text-text-2',
        mono && 'font-mono tabular',
        className,
      )}
    >
      {icon && <span className="flex shrink-0 text-text-3 [&_svg]:size-3.5">{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
  );
}

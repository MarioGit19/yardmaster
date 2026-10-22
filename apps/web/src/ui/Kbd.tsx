import type { ReactNode } from 'react';
import { cx } from './cx.js';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-chip border border-line bg-bg-2 px-1 font-mono text-meta text-text-2',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

import type { ReactNode } from 'react';
import { cx } from '../ui/cx.js';

/** Main-area page frame: 16px gutters on phones, 24px from tablet up. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('mx-auto w-full max-w-[1600px] p-4 md:p-6', className)}>{children}</div>
  );
}

export function PageHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <header className="mb-6 flex min-w-0 flex-col gap-1">
      <h1 className="truncate font-medium text-title text-text-1">{title}</h1>
      {meta && <div className="text-meta text-text-3">{meta}</div>}
    </header>
  );
}

/** A quiet centered message for empty or missing content. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-2 text-center">
      <p className="font-medium text-body text-text-1">{title}</p>
      {children && <div className="text-body-sm text-text-2">{children}</div>}
    </div>
  );
}

import type { ReactNode } from 'react';
import { Logomark } from '../brand/Logo.js';
import { cx } from '../ui/cx.js';

/** Main-area page frame: 16px gutters on phones, 24px from tablet up. `narrow` is for forms. */
export function Page({
  children,
  width = 'wide',
  className,
}: {
  children: ReactNode;
  width?: 'wide' | 'narrow';
  className?: string;
}) {
  return (
    <div
      className={cx(
        'mx-auto w-full p-4 md:p-6',
        width === 'narrow' ? 'max-w-2xl' : 'max-w-[1600px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <header className="mb-6 flex min-w-0 flex-col gap-1">
      <h1 className="truncate font-medium text-title text-text-1">{title}</h1>
      {meta && <div className="text-meta text-text-2">{meta}</div>}
    </header>
  );
}

/**
 * A quiet centered message for empty or missing content. `mark` heads it with the logomark, for
 * the board-level empty states.
 */
export function EmptyState({
  title,
  mark = false,
  children,
}: {
  title: string;
  mark?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-2 text-center">
      {mark && <Logomark className="mb-2 size-10 text-text-3" />}
      <p className="font-medium text-body text-text-1">{title}</p>
      {children && <div className="text-body-sm text-text-2">{children}</div>}
    </div>
  );
}

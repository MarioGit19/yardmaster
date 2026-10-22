import type { ReactNode } from 'react';

export function ColumnHeading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <h2 className="mb-3 flex min-w-0 items-baseline gap-2 font-medium text-body text-text-1">
      <span className="truncate">{children}</span>
      {meta !== undefined && <span className="tabular text-meta text-text-3">{meta}</span>}
    </h2>
  );
}

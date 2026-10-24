import type { SessionOrigin } from '@yardmaster/protocol';
import { LayoutDashboard, SquareTerminal } from 'lucide-react';
import { cx } from '../ui/cx.js';

const ORIGIN = {
  board: {
    label: 'Board',
    title: 'Board session: runs headless from Yardmaster',
    Icon: LayoutDashboard,
  },
  terminal: {
    label: 'Terminal',
    title: 'Terminal session: runs in an editor terminal',
    Icon: SquareTerminal,
  },
} as const;

/**
 * Where a session runs. Board sessions get the brighter outline, so the two read apart at a
 * glance without borrowing a status colour. `compact` shows the icon only; `narrow` does so
 * below the `sm` breakpoint.
 */
export function OriginBadge({
  origin,
  compact = false,
}: {
  origin: SessionOrigin;
  compact?: boolean | 'narrow';
}) {
  const { label, title, Icon } = ORIGIN[origin];
  return (
    <span
      title={title}
      data-origin={origin}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-chip border text-label',
        compact === true
          ? 'size-5 justify-center'
          : compact === 'narrow'
            ? 'size-5 justify-center sm:h-6 sm:w-auto sm:px-2'
            : 'h-6 px-2',
        origin === 'board' ? 'border-line-strong bg-bg-2 text-text-1' : 'border-line text-text-2',
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.5} />
      {compact === true ? (
        <span className="sr-only">{label}</span>
      ) : compact === 'narrow' ? (
        <span className="sr-only sm:not-sr-only">{label}</span>
      ) : (
        label
      )}
    </span>
  );
}

import type { Project } from '@c-board/protocol';
import { cx } from '../ui/cx.js';

/** The project's initial inside its accent ring. The accent is identity, never status. */
export function ProjectAvatar({
  project,
  size = 'md',
}: {
  project: Pick<Project, 'name' | 'accent'>;
  size?: 'md' | 'lg';
}) {
  const initial = Array.from(project.name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <span
      aria-hidden
      style={{ '--ring': `var(--accent-${project.accent})` } as React.CSSProperties}
      className={cx(
        'grid shrink-0 place-items-center rounded-full bg-bg-2 font-mono font-medium text-text-1 shadow-[inset_0_0_0_1.5px_var(--ring)]',
        size === 'md' ? 'size-6 text-meta' : 'size-10 text-title-sm',
      )}
    >
      {initial}
    </span>
  );
}

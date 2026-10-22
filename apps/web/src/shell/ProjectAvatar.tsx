import type { Project } from '@c-board/protocol';
import { cx } from '../ui/cx.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The first letter or digit of the name, as a whole grapheme ("Đ", "東"): an emoji prefix is
 * skipped, so "👩🏽‍💻 portfolio" reads "P". A name of only symbols shows its first one.
 */
export function projectInitial(name: string): string {
  let first: string | null = null;
  for (const { segment } of graphemes.segment(name.trim())) {
    if (/[\p{L}\p{N}]/u.test(segment)) return segment.toUpperCase();
    first ??= segment;
  }
  return first ?? '?';
}

/** The project's initial inside its accent ring. The accent is identity, never status. */
export function ProjectAvatar({
  project,
  size = 'md',
}: {
  project: Pick<Project, 'name' | 'accent'>;
  size?: 'sm' | 'md' | 'lg';
}) {
  const initial = projectInitial(project.name);
  return (
    <span
      aria-hidden
      style={{ '--ring': `var(--accent-${project.accent})` } as React.CSSProperties}
      className={cx(
        'grid shrink-0 place-items-center rounded-full bg-bg-2 font-mono font-medium text-text-1 shadow-[inset_0_0_0_1.5px_var(--ring)]',
        size === 'sm' && 'size-5 text-meta',
        size === 'md' && 'size-6 text-meta',
        size === 'lg' && 'size-10 text-title-sm',
      )}
    >
      {initial}
    </span>
  );
}

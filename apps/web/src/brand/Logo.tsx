import { useId } from 'react';
import { cx } from '../ui/cx.js';
import logoSource from './logo.svg?raw';
import { renderLogo } from './render.js';

/** The logomark, inline: the ring follows `currentColor`, the orb takes the work accent. */
export function Logomark({ className }: { className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const svg = renderLogo(logoSource, { ring: 'currentColor', accent: 'var(--st-work)' }, id);
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block shrink-0 [&>svg]:size-full', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own bundled SVG, recolored with fixed strings.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Logomark plus the `c-board` wordmark in Geist Mono 500 (DESIGN.md §4.9). */
export function Wordmark({
  className,
  nameClassName,
}: {
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-medium font-mono', className)}>
      <Logomark className="size-5 text-text-2" />
      <span className={nameClassName}>c-board</span>
    </span>
  );
}

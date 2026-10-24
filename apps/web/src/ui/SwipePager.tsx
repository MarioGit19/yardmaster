import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useMotionLevel } from '../motion.js';
import { cx } from './cx.js';
import { IconButton } from './IconButton.js';

export interface SwipePage {
  key: string;
  /** Read out with the page's position, such as "Claude screen" or "Lines 1 to 4". */
  label: string;
  node: ReactNode;
}

/** The page a scroll position rests on, for pages `stride` px apart. */
export function pageAt(scrollLeft: number, stride: number, pages: number): number {
  if (stride <= 0 || pages <= 0) return 0;
  return Math.min(pages - 1, Math.max(0, Math.round(scrollLeft / stride)));
}

/** The distance from one page to the next: a page's width plus the gap. */
function strideOf(el: HTMLElement): number {
  const [first, second] = el.children as unknown as HTMLElement[];
  if (first && second) return second.offsetLeft - first.offsetLeft;
  return el.clientWidth;
}

/**
 * A row of full-width screens you swipe through (DESIGN.md §10.1 phones): native scroll snap does
 * the gesture and its momentum, one page per swipe, and the pager under it shows where you are,
 * with previous and next buttons for anyone who doesn't swipe.
 */
export function SwipePager({
  label,
  pages,
  nav = 'bottom',
  className,
  ...data
}: {
  label: string;
  pages: readonly SwipePage[];
  /** Where the pager sits: under short pages, or above tall ones so it's in reach at the top. */
  nav?: 'top' | 'bottom';
  className?: string;
} & { [key: `data-${string}`]: string | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const level = useMotionLevel();
  const count = pages.length;

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) setCurrent(pageAt(el.scrollLeft, strideOf(el), count));
  }, [count]);
  // Pages that leave (a project closing, a terminal exiting) don't strand the pager past the end.
  useEffect(onScroll, [onScroll]);

  const go = (index: number) => {
    const el = scroller.current;
    if (!el) return;
    const to = Math.min(count - 1, Math.max(0, index));
    el.scrollTo({ left: to * strideOf(el), behavior: level === 'full' ? 'smooth' : 'auto' });
  };

  return (
    <section
      aria-roledescription="carousel"
      aria-label={label}
      className={cx('flex min-w-0 flex-col gap-2', className)}
      {...data}
    >
      <div ref={scroller} onScroll={onScroll} data-swipe-pager className="swipe-pager">
        {pages.map((page, i) => (
          <section
            key={page.key}
            data-swipe-page={i}
            aria-roledescription="slide"
            aria-label={`${page.label}, ${i + 1} of ${count}`}
            className="swipe-page"
          >
            {page.node}
          </section>
        ))}
      </div>
      {count > 1 && (
        <nav
          aria-label={`${label} pages`}
          className={cx('flex items-center justify-center gap-1', nav === 'top' && 'order-first')}
        >
          <IconButton
            label="Previous screen"
            size="sm"
            disabled={current === 0}
            onClick={() => go(current - 1)}
            icon={<ChevronLeft aria-hidden className="size-4" strokeWidth={1.5} />}
          />
          <p
            data-swipe-position={current}
            aria-live="polite"
            className="flex min-w-16 items-center justify-center gap-1.5"
          >
            <span className="sr-only">
              {pages[current]?.label}, {current + 1} of {count}
            </span>
            {pages.map((page, i) => (
              <span
                key={page.key}
                aria-hidden
                data-active={i === current || undefined}
                className="swipe-dot"
              />
            ))}
          </p>
          <IconButton
            label="Next screen"
            size="sm"
            disabled={current === count - 1}
            onClick={() => go(current + 1)}
            icon={<ChevronRight aria-hidden className="size-4" strokeWidth={1.5} />}
          />
        </nav>
      )}
    </section>
  );
}

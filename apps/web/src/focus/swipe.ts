import { type TouchEvent, useRef } from 'react';

/** A swipe travels at least this far sideways (px)… */
const MIN_DX = 56;
/** …mostly sideways… */
const MAX_SLOPE = 0.6;
/** …and quickly (ms): a slow drag is reading, not switching. */
const MAX_MS = 1000;

/** Inside these a sideways drag belongs to the content: text fields, the terminal, sheets. */
const OWN_GESTURES =
  'input, textarea, select, [contenteditable], .xterm, [data-xterm], [data-no-swipe]';

/** Whether something under the touch scrolls sideways itself (a diff, code, a wide table). */
export function scrollsSideways(target: Element | null, stop: Element | null): boolean {
  for (let el = target; el && el !== stop; el = el.parentElement) {
    if (el.matches(OWN_GESTURES)) return true;
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
  }
  return false;
}

/** The tab step a finished touch asks for: 1 (swiped left, next), -1 (right, previous) or 0. */
export function swipeStep(dx: number, dy: number, ms: number): -1 | 0 | 1 {
  if (ms > MAX_MS || Math.abs(dx) < MIN_DX || Math.abs(dy) > Math.abs(dx) * MAX_SLOPE) return 0;
  return dx < 0 ? 1 : -1;
}

/**
 * Touch handlers for a tab panel area: a quick horizontal swipe calls `onStep` with the direction,
 * unless it started on something that takes sideways drags itself. Vertical scrolling is untouched
 * (no `preventDefault`, so the listeners stay passive).
 */
export function useTabSwipe(onStep: (step: 1 | -1) => void) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  return {
    onTouchStart(event: TouchEvent<HTMLElement>) {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        start.current = null;
        return;
      }
      const owned = scrollsSideways(event.target as Element, event.currentTarget);
      start.current = owned ? null : { x: touch.clientX, y: touch.clientY, t: event.timeStamp };
    },
    onTouchEnd(event: TouchEvent<HTMLElement>) {
      const from = start.current;
      start.current = null;
      const touch = event.changedTouches[0];
      if (!from || !touch) return;
      const step = swipeStep(
        touch.clientX - from.x,
        touch.clientY - from.y,
        event.timeStamp - from.t,
      );
      if (step !== 0) onStep(step);
    },
    onTouchCancel() {
      start.current = null;
    },
  };
}

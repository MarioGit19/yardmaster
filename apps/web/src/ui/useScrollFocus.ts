import { useCallback, useRef } from 'react';

/** True when the box has content to scroll to, on either axis (1 px of slack for rounding). */
export function overflows(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

/**
 * A ref for a scroll box (code block, diff hunk) that becomes a labelled Tab stop while its
 * content overflows, so keyboard users can scroll it with the arrows (WCAG 2.1.1). Boxes that fit
 * stay out of the Tab order.
 */
export function useScrollFocus<T extends HTMLElement>(label: string) {
  const labelRef = useRef(label);
  labelRef.current = label;
  return useCallback((el: T | null) => {
    if (!el) return;
    const sync = () => {
      if (overflows(el)) {
        el.tabIndex = 0;
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', labelRef.current);
      } else {
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
      }
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, []);
}

import { useCallback } from 'react';

const heights = new Map<Element, number>();
let observer: ResizeObserver | null = null;

function publish() {
  const tallest = Math.max(0, ...heights.values());
  document.documentElement.style.setProperty('--composer-h', `${Math.round(tallest)}px`);
}

/**
 * Publishes the tallest composer on screen as `--composer-h`, so toasts in a phone workspace sit
 * above it (DESIGN.md §11). A composer in a hidden tab measures 0 and doesn't count.
 */
export function useComposerLift() {
  return useCallback((el: HTMLElement | null) => {
    if (typeof ResizeObserver === 'undefined' || !el) return;
    observer ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target.isConnected) heights.set(target, target.offsetHeight);
        else heights.delete(target);
      }
      publish();
    });
    observer.observe(el);
    return () => {
      observer?.unobserve(el);
      heights.delete(el);
      publish();
    };
  }, []);
}

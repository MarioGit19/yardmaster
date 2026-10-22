import { createContext, type RefObject, useContext, useEffect, useRef, useState } from 'react';
import { type FrameCallback, frameScheduler, type Scheduler } from './scheduler.js';

export interface UseFrameOptions {
  /** Usually from `useInView`: off-screen callbacks receive no frames. */
  visible?: boolean;
  /** False when there is nothing to animate (idle entities register no work). */
  enabled?: boolean;
  scheduler?: Scheduler;
}

/** Runs `callback` on the shared rAF loop while `visible && enabled`. */
export function useFrame(
  callback: FrameCallback,
  { visible = true, enabled = true, scheduler }: UseFrameOptions = {},
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const active = visible && enabled;

  useEffect(() => {
    if (!active) return;
    const handle = (scheduler ?? frameScheduler()).add((now, dt) => callbackRef.current(now, dt));
    return () => handle.remove();
  }, [active, scheduler]);
}

/**
 * True inside content that is mounted but covered (the overview under the focus view): it counts
 * as off screen, so its orbs, sparklines and mascots stop drawing.
 */
export const OffstageContext = createContext(false);

type ViewListener = (visible: boolean) => void;

const listeners = new Map<Element, Set<ViewListener>>();
let observer: IntersectionObserver | null = null;

function sharedObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        for (const listener of listeners.get(entry.target) ?? []) listener(entry.isIntersecting);
      }
    },
    // A little margin, so motion is already running when an orb scrolls into view.
    { rootMargin: '64px' },
  );
  return observer;
}

/**
 * Whether the element is on screen, via one shared IntersectionObserver. Without
 * IntersectionObserver support everything counts as visible.
 */
export function useInView(ref: RefObject<Element | null>): boolean {
  const offstage = useContext(OffstageContext);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const io = sharedObserver();
    let set = listeners.get(element);
    if (!set) {
      set = new Set();
      listeners.set(element, set);
      io.observe(element);
    }
    set.add(setVisible);
    return () => {
      set.delete(setVisible);
      if (set.size === 0) {
        listeners.delete(element);
        io.unobserve(element);
      }
    };
  }, [ref]);

  return visible && !offstage;
}

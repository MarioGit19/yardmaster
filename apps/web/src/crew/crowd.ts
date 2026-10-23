import { type RefObject, useEffect } from 'react';

/** More crew than this animating on screen halves their typing rate (8 Hz → 4 Hz). */
export const CROWD_SIZE = 10;

const live = new Set<HTMLElement>();
let crowded = false;

function mark(element: HTMLElement, on: boolean): void {
  if (on === element.hasAttribute('data-crew-crowd')) return;
  if (on) element.dataset.crewCrowd = '';
  else delete element.dataset.crewCrowd;
}

/**
 * Counts this crew member while it animates on screen (`active`), and marks every live member's
 * root while the crowd is large; CSS slows the typing taps under it. The mark sits on the crew
 * roots, not the document, so toggling it restyles only the crew.
 */
export function useCrewCrowd(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    live.add(element);
    update(element);
    return () => {
      live.delete(element);
      mark(element, false);
      update(null);
    };
  }, [active, ref]);
}

function update(added: HTMLElement | null): void {
  const next = live.size > CROWD_SIZE;
  if (next !== crowded) {
    crowded = next;
    for (const member of live) mark(member, crowded);
  } else if (added) mark(added, crowded);
}

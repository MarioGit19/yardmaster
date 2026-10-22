import { useEffect } from 'react';

/** More crew than this animating on screen halves their typing rate (8 Hz → 4 Hz). */
export const CROWD_SIZE = 10;

const live = new Set<object>();

/** Marks the root while the crowd is large; CSS slows the typing taps under it. */
function update(root: HTMLElement): void {
  const crowded = live.size > CROWD_SIZE;
  if (crowded === root.hasAttribute('data-crew-crowd')) return;
  if (crowded) root.dataset.crewCrowd = '';
  else delete root.dataset.crewCrowd;
}

/** Counts this crew member while it animates on screen (`active`). */
export function useCrewCrowd(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const member = {};
    live.add(member);
    update(document.documentElement);
    return () => {
      live.delete(member);
      update(document.documentElement);
    };
  }, [active]);
}

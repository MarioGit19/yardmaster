import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { layoutPreference } from '../../layouts/registry.js';
import { type MotionLevel, useMotionLevel } from '../../motion.js';
import { usePreference } from '../../prefs.js';
import { minimalSkin } from './minimal.js';
import { LAYOUT_SKIN, loadedSkin, loadSkin, type SkinId } from './registry.js';
import type { WorkspaceSkin } from './types.js';

export interface ActiveSkin {
  id: SkinId;
  skin: WorkspaceSkin;
}

/**
 * The skin the open workspace wears: the chosen layout's (DESIGN.md §10.8). Undefined while the
 * first one loads. A layout switch while the workspace is open waits for the new skin's chunk, then
 * cross-fades the old look into the new one (§10.1, `dur.slow`); at Off it swaps at once. A chunk
 * that fails to load leaves Minimal's look.
 */
export function useWorkspaceSkin(): ActiveSkin | undefined {
  const wanted = LAYOUT_SKIN[usePreference(layoutPreference)];
  const level = useMotionLevel();
  const [shown, setShown] = useState<SkinId | null>(() => (loadedSkin(wanted) ? wanted : null));

  useEffect(() => {
    if (shown === wanted) return;
    let live = true;
    const ready = () => {
      if (!live) return;
      if (shown === null) setShown(wanted);
      else crossFade(() => setShown(wanted), level);
    };
    loadSkin(wanted).then(ready, ready);
    return () => {
      live = false;
    };
  }, [wanted, shown, level]);

  if (shown === null) return undefined;
  return { id: shown, skin: loadedSkin(shown) ?? minimalSkin };
}

/**
 * One workspace, two looks: the browser snapshots the old skin and cross-fades it into the new one,
 * so nothing in the workspace mounts twice (terminals, composers, streams).
 */
function crossFade(update: () => void, level: MotionLevel) {
  if (level === 'off' || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.skinSwap = '';
  const transition = document.startViewTransition(() => flushSync(update));
  transition.finished.finally(() => delete root.dataset.skinSwap);
}

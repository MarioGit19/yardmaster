import { createContext, useContext } from 'react';
import type { LayoutId } from '../../layouts/registry.js';
import { minimalSkin } from './minimal.js';
import type { WorkspaceSkin } from './types.js';

/**
 * Which skin each layout's workspace wears (DESIGN.md §10.8). Minimal is the reference skin and
 * ships with the app; the others load with their layout. Layouts without their own skin yet wear
 * Minimal's.
 */
export type SkinId = 'minimal' | 'grid' | 'retro';

export const LAYOUT_SKIN: Record<LayoutId, SkinId> = {
  minimal: 'minimal',
  office: 'minimal',
  grid: 'grid',
  transit: 'minimal',
  retro: 'retro',
};

const LOADERS: Record<Exclude<SkinId, 'minimal'>, () => Promise<{ default: WorkspaceSkin }>> = {
  grid: () => import('./grid/GridSkin.js'),
  retro: () => import('./retro/RetroSkin.js'),
};

const loaded: Partial<Record<SkinId, WorkspaceSkin>> = { minimal: minimalSkin };
const loading: Partial<Record<SkinId, Promise<WorkspaceSkin>>> = {};

/** A skin, loading its chunk (and its CSS) the first time. */
export function loadSkin(id: SkinId): Promise<WorkspaceSkin> {
  const ready = loaded[id];
  if (ready) return Promise.resolve(ready);
  if (id === 'minimal') return Promise.resolve(minimalSkin);
  loading[id] ??= LOADERS[id]().then(
    (module) => {
      loaded[id] = module.default;
      return module.default;
    },
    (error: unknown) => {
      delete loading[id];
      throw error;
    },
  );
  return loading[id];
}

/** A skin whose chunk has arrived, or undefined. */
export const loadedSkin = (id: SkinId): WorkspaceSkin | undefined => loaded[id];

/** The skin the surrounding workspace wears, for parts that theme outside CSS (xterm). */
export const SkinContext = createContext<SkinId>('minimal');
export const useSkinId = () => useContext(SkinContext);

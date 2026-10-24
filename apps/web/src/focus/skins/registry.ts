import { createContext, useContext } from 'react';
import type { LayoutId } from '../../layouts/registry.js';
import { minimalSkin } from './minimal.js';
import type { StatusWordInput, WorkspaceSkin } from './types.js';

/**
 * Which skin each layout's workspace wears (DESIGN.md §10.8). Minimal is the reference skin and
 * ships with the app; the others load with their layout.
 */
export type SkinId = 'minimal' | 'office' | 'grid' | 'transit' | 'retro';

export const LAYOUT_SKIN: Record<LayoutId, SkinId> = {
  minimal: 'minimal',
  office: 'office',
  grid: 'grid',
  transit: 'transit',
  retro: 'retro',
};

const LOADERS: Record<Exclude<SkinId, 'minimal'>, () => Promise<{ default: WorkspaceSkin }>> = {
  office: () => import('./office/OfficeSkin.js'),
  grid: () => import('./grid/GridSkin.js'),
  transit: () => import('./transit/TransitSkin.js'),
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

/**
 * The status words of the surrounding workspace's skin: its own (Transit's board words) or the
 * standard label.
 */
export function useStatusWord(): (input: StatusWordInput, label: string) => string {
  const words = loadedSkin(useSkinId())?.statusWord;
  return (input, label) => words?.(input) ?? label;
}

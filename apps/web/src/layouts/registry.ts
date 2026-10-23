import { type ComponentType, type LazyExoticComponent, lazy } from 'react';
import { createPreference } from '../prefs.js';

/** DESIGN.md §10: the overview's layouts, in switcher and `⌥1`…`⌥5` order. */
export const LAYOUTS = ['minimal', 'office', 'grid', 'transit', 'retro'] as const;
export type LayoutId = (typeof LAYOUTS)[number];

export const LAYOUT_NAME: Record<LayoutId, string> = {
  minimal: 'Minimal',
  office: 'Office',
  grid: 'Grid',
  transit: 'Transit',
  retro: 'Retro',
};

/** Per browser; an unknown stored value falls back to Minimal. */
export const layoutPreference = createPreference<LayoutId>('cboard.layout', LAYOUTS, 'minimal');

type Loader = () => Promise<{ default: ComponentType }>;

const LOADERS: Record<LayoutId, Loader> = {
  minimal: () => import('./minimal/MinimalLayout.js'),
  office: () => import('./placeholder/OfficeLayout.js'),
  grid: () => import('./placeholder/GridLayout.js'),
  transit: () => import('./placeholder/TransitLayout.js'),
  retro: () => import('./placeholder/RetroLayout.js'),
};

/** Layouts whose chunk has arrived: these render without suspending. */
const loaded: Partial<Record<LayoutId, ComponentType>> = {};

function load(id: LayoutId) {
  return LOADERS[id]().then((module) => {
    loaded[id] = module.default;
    return module;
  });
}

const LAZY = Object.fromEntries(LAYOUTS.map((id) => [id, lazy(() => load(id))])) as Record<
  LayoutId,
  LazyExoticComponent<ComponentType>
>;

/**
 * A layout's overview component. Each layout is its own chunk: a loaded one renders at once,
 * another suspends (show a skeleton) until its chunk arrives.
 */
export function layoutComponent(id: LayoutId): ComponentType {
  return loaded[id] ?? LAZY[id];
}

/** Starts loading a layout's chunk early (the stored one at startup), so it rarely suspends. */
export function preloadLayout(id: LayoutId): Promise<void> {
  return load(id).then(
    () => undefined,
    () => {
      // The lazy component retries and shows the error where it renders.
    },
  );
}

/** `⌥1`…`⌥5` by physical key (on macOS `⌥1` types "¡"), or null. */
export function layoutShortcut(
  event: Pick<KeyboardEvent, 'code' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey'>,
): LayoutId | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  const match = /^Digit([1-9])$/.exec(event.code);
  if (!match) return null;
  return LAYOUTS[Number(match[1]) - 1] ?? null;
}

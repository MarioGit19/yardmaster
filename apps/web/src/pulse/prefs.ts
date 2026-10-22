import { createPreference } from '../prefs.js';
import { PULSE_FILTERS, type PulseFilter } from './model.js';

/** `auto` until the user toggles: collapsed on short or narrow screens, else expanded. */
export const pulsePreference = createPreference<'auto' | 'expanded' | 'collapsed'>(
  'cboard.pulse',
  ['auto', 'expanded', 'collapsed'],
  'auto',
);

/** Screens where the expanded rail would take too much of the board (DESIGN.md §4.7). */
export const PULSE_COMPACT_QUERY = '(max-height: 959px), (max-width: 767px)';

export const pulseFilterPreference = createPreference<PulseFilter>(
  'cboard.pulse.filter',
  PULSE_FILTERS,
  'all',
);

const isCompact = () => globalThis.matchMedia?.(PULSE_COMPACT_QUERY).matches ?? false;

/** Whether the rail shows collapsed for a preference on a compact screen or not. */
export function pulseCollapsed(
  setting: 'auto' | 'expanded' | 'collapsed',
  compact: boolean,
): boolean {
  return setting === 'auto' ? compact : setting === 'collapsed';
}

export function togglePulse(): void {
  const collapsed = pulseCollapsed(pulsePreference.get(), isCompact());
  pulsePreference.set(collapsed ? 'expanded' : 'collapsed');
}

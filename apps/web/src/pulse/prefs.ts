import { createPreference } from '../prefs.js';
import { PULSE_FILTERS, type PulseFilter } from './model.js';

export const pulsePreference = createPreference<'expanded' | 'collapsed'>(
  'cboard.pulse',
  ['expanded', 'collapsed'],
  'expanded',
);

export const pulseFilterPreference = createPreference<PulseFilter>(
  'cboard.pulse.filter',
  PULSE_FILTERS,
  'all',
);

export function togglePulse(): void {
  pulsePreference.set(pulsePreference.get() === 'collapsed' ? 'expanded' : 'collapsed');
}

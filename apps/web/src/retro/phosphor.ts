import type { Phosphor } from '../fx/FaultyTerminal.js';
import { createPreference } from '../prefs.js';

export const PHOSPHORS = ['green', 'amber'] as const satisfies readonly Phosphor[];

export const PHOSPHOR_LABEL: Record<Phosphor, string> = { green: 'Green', amber: 'Amber' };

/** The Retro console's phosphor (DESIGN.md §10.6), per browser: green, or amber as the option. */
export const phosphorPreference = createPreference<Phosphor>('cboard.phosphor', PHOSPHORS, 'green');

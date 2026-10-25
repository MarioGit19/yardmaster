import type { Phosphor } from '../fx/FaultyTerminal.js';
import { createPreference } from '../prefs.js';

export const PHOSPHORS = [
  'green',
  'amber',
  'red',
  'purple',
  'cyan',
  'white',
] as const satisfies readonly Phosphor[];

export const PHOSPHOR_LABEL: Record<Phosphor, string> = {
  green: 'Green',
  amber: 'Amber',
  red: 'Red',
  purple: 'Purple',
  cyan: 'Cyan',
  white: 'White',
};

/** The Retro console's phosphor (DESIGN.md §10.6), per browser: green by default. */
export const phosphorPreference = createPreference<Phosphor>(
  'yardmaster.phosphor',
  PHOSPHORS,
  'green',
);

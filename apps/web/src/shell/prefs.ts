import { createPreference } from '../prefs.js';

export const railPreference = createPreference<'expanded' | 'collapsed'>(
  'yardmaster.rail',
  ['expanded', 'collapsed'],
  'expanded',
);

/** Phones: below this width the app is the phone shell (DESIGN.md §11), without the rail. */
export const NARROW_QUERY = '(max-width: 767px)';

/** Up to this width the desktop shell's rail shows icons only. */
export const RAIL_ICONS_QUERY = '(max-width: 1023px)';

import { createPreference } from '../prefs.js';

export const railPreference = createPreference<'expanded' | 'collapsed'>(
  'cboard.rail',
  ['expanded', 'collapsed'],
  'expanded',
);

/** Below this width the rail always shows icons only. */
export const NARROW_QUERY = '(max-width: 767px)';

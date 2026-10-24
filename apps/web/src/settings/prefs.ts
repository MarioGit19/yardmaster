import { createPreference } from '../prefs.js';

/** Mask secrets in terminals, tool cards and messages (PRD §8.7). On unless turned off. */
export const redactPreference = createPreference<'on' | 'off'>(
  'yardmaster.redact',
  ['on', 'off'],
  'on',
);

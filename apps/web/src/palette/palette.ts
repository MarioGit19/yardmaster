import { createPreference, type KeyValueStorage } from '../prefs.js';

// In memory only: a reload starts with the palette closed.
const memory: KeyValueStorage = { getItem: () => null, setItem: () => {} };

export const paletteOpen = createPreference<'open' | 'closed'>(
  'yardmaster.palette',
  ['open', 'closed'],
  'closed',
  memory,
);

/** ⌘K on macOS, Ctrl+K elsewhere; both work everywhere so a remapped keyboard isn't stuck. */
export function isPaletteShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (
    event.key.toLowerCase() === 'k' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

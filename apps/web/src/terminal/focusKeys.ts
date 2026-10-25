/**
 * Whether a key leaves the terminal to the browser's focus order instead of going to the program
 * (WCAG 2.1.2, no keyboard trap). A read-only mirror lets Tab and Shift+Tab move focus; a board
 * terminal keeps Tab for the shell's completion and lets Shift+Tab leave.
 */
export function releasesFocus(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>,
  input: boolean,
): boolean {
  if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return false;
  return !input || event.shiftKey;
}

/**
 * Roving focus for the project rail: which item a key moves to, or null when the key isn't
 * ours. ArrowUp/Down (and k/j) wrap; Home/End jump to the ends.
 */
export function railKeyTarget(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
    case 'j':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
    case 'k':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** True when a keystroke belongs to a text field, so global shortcuts must ignore it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A compact past time: `just now`, `12m ago`, `3h ago`, `yesterday`, `4d ago`, `Mar 4`. */
export function formatWhen(ts: number, now: number): string {
  const ms = now - ts;
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  const days = Math.floor(ms / DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** The full local date and time, for a tooltip. */
export const formatDateTime = (ts: number) =>
  new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

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

/** A start time that tells sessions apart: `14:05` today, `Mar 4, 14:05` before. */
export function formatStarted(ts: number, now: number): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

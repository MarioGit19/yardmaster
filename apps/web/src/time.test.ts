import { describe, expect, it } from 'vitest';
import { formatStarted, formatWhen } from './time.js';

const NOW = new Date(2026, 5, 15, 12, 0).getTime();
const MIN = 60_000;

describe('formatWhen', () => {
  it('scales from minutes to dates', () => {
    expect(formatWhen(NOW - 20_000, NOW)).toBe('just now');
    expect(formatWhen(NOW - 12 * MIN, NOW)).toBe('12m ago');
    expect(formatWhen(NOW - 3 * 60 * MIN, NOW)).toBe('3h ago');
    expect(formatWhen(NOW - 30 * 60 * MIN, NOW)).toBe('yesterday');
    expect(formatWhen(NOW - 4 * 24 * 60 * MIN, NOW)).toBe('4d ago');
    expect(formatWhen(new Date(2026, 2, 4).getTime(), NOW)).toBe('Mar 4');
    expect(formatWhen(new Date(2025, 2, 4).getTime(), NOW)).toBe('Mar 4, 2025');
  });

  it('treats a clock skew into the future as now', () => {
    expect(formatWhen(NOW + 5 * MIN, NOW)).toBe('just now');
  });
});

describe('formatStarted', () => {
  it('shows the time today and adds the day before', () => {
    const now = new Date(2026, 2, 4, 18, 30).getTime();
    expect(formatStarted(new Date(2026, 2, 4, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatStarted(new Date(2026, 2, 3, 23, 59).getTime(), now)).toBe('Mar 3, 23:59');
  });
});

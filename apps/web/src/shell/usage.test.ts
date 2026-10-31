import { describe, expect, it } from 'vitest';
import { usageAsOf, usageLabel, usageRows, usedText } from './usage.js';

const NOW = new Date(2026, 9, 28, 12, 0).getTime();
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();
const usage = (fiveHour: number | null, sevenDay: number | null = null) => ({
  fiveHour: fiveHour === null ? null : { usedPercent: fiveHour, resetsAt: at(28, 15, 10) },
  sevenDay: sevenDay === null ? null : { usedPercent: sevenDay, resetsAt: at(30, 9) },
  at: at(28, 11, 45),
});

describe('usageRows', () => {
  it('has nothing to show without usage', () => {
    expect(usageRows(null, null, NOW)).toEqual([]);
    expect(usageRows(undefined, null, NOW)).toEqual([]);
  });

  it('shows only the windows the account reports', () => {
    expect(usageRows(usage(null, 18), null, NOW).map((row) => row.key)).toEqual(['sevenDay']);
  });

  it('rounds the percent and says when each window resets', () => {
    const [five, seven] = usageRows(usage(41.6, 18), null, NOW);
    expect(five).toMatchObject({ percent: 42, reset: 'resets at 3:10 PM' });
    expect(seven?.reset).toBe('resets at Fri 9:00 AM');
  });

  it('warns at each window’s own threshold', () => {
    const warn = { usageWarnFiveHour: 50, usageWarnSevenDay: 90 } as const;
    const [five, seven] = usageRows(usage(50, 89), warn, NOW);
    expect(five?.warn).toBe(true);
    expect(seven?.warn).toBe(false);
    expect(usageRows(usage(79), null, NOW)[0]?.warn).toBe(false);
    expect(usageRows(usage(80), null, NOW)[0]?.warn).toBe(true);
  });

  it('stops vouching for a window that has reset', () => {
    const [row] = usageRows(usage(97), null, at(28, 16));
    expect(row).toMatchObject({ percent: null, warn: false, reset: 'reset at 3:10 PM' });
    expect(row && usedText(row)).toBe('—');
  });

  it('says when it was read', () => {
    const value = usage(42);
    expect(usageAsOf(value, NOW)).toBe('as of 11:45 AM');
    expect(usageLabel(usageRows(value, null, NOW), value, NOW)).toBe(
      'Claude usage: 5-hour 42% used, resets at 3:10 PM; as of 11:45 AM',
    );
  });
});

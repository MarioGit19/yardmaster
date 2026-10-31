import {
  type AccountUsage,
  type BoardSettings,
  DEFAULT_USAGE_WARN_PERCENT,
} from '@yardmaster/protocol';
import { formatClock } from '../time.js';

export interface UsageRow {
  key: 'fiveHour' | 'sevenDay';
  short: string;
  name: string;
  /** Whole percent used, or null once the window has reset: the reading is from the old one. */
  percent: number | null;
  warn: boolean;
  /** "resets at 3:10 PM", or "reset at 3:10 PM" once it has. */
  reset: string;
}

type Warn = Pick<BoardSettings, 'usageWarnFiveHour' | 'usageWarnSevenDay'> | null;

/** The windows the account reports, as the chip and the phone's More page show them. */
export function usageRows(usage: AccountUsage | null | undefined, warn: Warn, now: number) {
  if (!usage) return [];
  const rows: UsageRow[] = [];
  const add = (
    key: UsageRow['key'],
    short: string,
    name: string,
    threshold: number | undefined,
  ) => {
    const window = usage[key];
    if (!window) return;
    const passed = window.resetsAt <= now;
    rows.push({
      key,
      short,
      name,
      percent: passed ? null : Math.round(window.usedPercent),
      warn: !passed && window.usedPercent >= (threshold ?? DEFAULT_USAGE_WARN_PERCENT),
      reset: `${passed ? 'reset' : 'resets'} at ${formatClock(window.resetsAt, now)}`,
    });
  };
  add('fiveHour', '5h', '5-hour', warn?.usageWarnFiveHour);
  add('sevenDay', '7d', '7-day', warn?.usageWarnSevenDay);
  return rows;
}

export const usedText = (row: UsageRow) => (row.percent === null ? '—' : `${row.percent}%`);

/** The data only moves while a session runs, so it always says when it was read. */
export const usageAsOf = (usage: AccountUsage, now: number) =>
  `as of ${formatClock(usage.at, now)}`;

export const usageLabel = (rows: readonly UsageRow[], usage: AccountUsage, now: number) =>
  `Claude usage: ${rows
    .map(
      (row) =>
        `${row.name} ${row.percent === null ? 'window' : `${row.percent}% used,`} ${row.reset}`,
    )
    .join('; ')}; ${usageAsOf(usage, now)}`;

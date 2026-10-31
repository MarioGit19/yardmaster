import { TriangleAlert } from 'lucide-react';
import { Link } from 'wouter';
import { useNow } from '../anim/clock.js';
import { selectUsage, useBoard } from '../data/index.js';
import { useBoardSettings } from '../settings/boardSettings.js';
import { cx } from '../ui/cx.js';
import { Tooltip } from '../ui/Tooltip.js';
import { COUNTER_BUTTON } from './HudCounters.js';
import { type UsageRow, usageAsOf, usageLabel, usageRows, usedText } from './usage.js';

const MINUTE = 60_000;

function useUsage() {
  const usage = useBoard(selectUsage);
  const { settings } = useBoardSettings();
  const now = useNow(MINUTE);
  return { usage, now, rows: usageRows(usage, settings, now) };
}

function WarnMark({ row }: { row: UsageRow }) {
  if (!row.warn) return null;
  return <TriangleAlert aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />;
}

/**
 * 5-hour and 7-day usage in the top bar, hidden when the account reports neither. It links to
 * where the thresholds are set (`href`): Settings, or More on a phone.
 */
export function UsageChip({ href, className }: { href: string; className?: string }) {
  const { usage, now, rows } = useUsage();
  if (!usage || rows.length === 0) return null;
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <span key={row.key}>
              {row.name}: {usedText(row)}, {row.reset}
            </span>
          ))}
          <span className="text-text-3">{usageAsOf(usage, now)}</span>
        </span>
      }
    >
      <Link
        href={href}
        data-hud="usage"
        aria-label={usageLabel(rows, usage, now)}
        className={cx(
          COUNTER_BUTTON,
          'tabular h-7 shrink-0 gap-2 px-2 font-mono text-meta text-text-2 touch:h-11',
          className,
        )}
      >
        {rows.map((row) => (
          <span
            key={row.key}
            data-usage={row.key}
            data-warn={row.warn || undefined}
            className={cx('flex items-center gap-1', row.warn && 'text-st-wait-ink')}
          >
            <WarnMark row={row} />
            <span className={cx(!row.warn && 'text-text-3')}>{row.short}</span>
            {usedText(row)}
          </span>
        ))}
      </Link>
    </Tooltip>
  );
}

/** The same reading spelled out, for the phone's More page. */
export function UsageList() {
  const { usage, now, rows } = useUsage();
  if (!usage || rows.length === 0) return null;
  return (
    <section aria-labelledby="more-usage" className="flex flex-col gap-3">
      <h2 id="more-usage" className="px-1 font-medium text-body-sm text-text-2">
        Claude usage
      </h2>
      <div
        data-more="usage"
        className="flex flex-col divide-y divide-line rounded-panel border border-line bg-bg-1 shadow-raised"
      >
        {rows.map((row) => (
          <div key={row.key} data-usage={row.key} className="flex min-h-12 items-center gap-3 px-4">
            <span className="min-w-0 flex-1">
              <span className="block text-body text-text-1">{row.name}</span>
              <span className="block text-meta text-text-2">{row.reset}</span>
            </span>
            <span
              className={cx(
                'tabular flex items-center gap-1 font-mono text-body',
                row.warn ? 'text-st-wait-ink' : 'text-text-1',
              )}
            >
              <WarnMark row={row} />
              {usedText(row)}
            </span>
          </div>
        ))}
      </div>
      <p className="px-1 text-meta text-text-2">
        {usageAsOf(usage, now)}. Updates while a Claude session runs.
      </p>
    </section>
  );
}

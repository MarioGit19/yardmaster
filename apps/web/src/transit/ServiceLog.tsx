import { type CSSProperties, useMemo } from 'react';
import { countOf } from '../plural.js';
import { formatAgo } from '../pulse/model.js';
import { cx } from '../ui/cx.js';
import {
  BIN_PX,
  binHeight,
  binTarget,
  type EventKind,
  type LogBin,
  placeBins,
  type ServiceEvent,
} from './map.js';
import { tipHandlers, useFresh, useOpenEvent, useTip } from './shared.js';

const KIND_WORD: Record<EventKind, string> = {
  turn: 'turn finished',
  ok: 'command exited ✓',
  fail: 'command failed ×',
  commit: 'commit',
  crash: 'crash',
};

function binLabel(bin: LogBin, now: number): string {
  const newest = binTarget(bin);
  const what = `${newest.label}${newest.detail ? `: ${newest.detail}` : ''}, ${formatAgo(now - newest.ts)}`;
  if (bin.events.length === 1) return what;
  return `${countOf(bin.events.length, 'event')}, the worst a ${KIND_WORD[bin.kind]}. Newest: ${what}`;
}

/**
 * A line's service log (DESIGN.md §10.5): the last hour under the line, in fixed bins that each
 * hold a bar for their events (taller with more of them) in the worst kind's color, a diamond on
 * a failure and a ring on a commit. Hover shows what happened, a click jumps to the newest.
 */
export function ServiceLog({
  events,
  now,
  width,
  binPx = BIN_PX,
  height,
  className,
  style,
}: {
  events: readonly ServiceEvent[];
  now: number;
  width: number;
  binPx?: number;
  height: number;
  className?: string;
  style?: CSSProperties;
}) {
  const bins = useMemo(() => placeBins(events, now, width, binPx), [events, now, width, binPx]);
  const fresh = useFresh(bins.map((b) => b.id));
  const tip = useTip();
  const open = useOpenEvent();
  return (
    <div
      data-transit-log
      className={cx('transit-log', className)}
      style={{ ...style, width, height, '--bin': `${binPx}px` } as CSSProperties}
    >
      <span aria-hidden className="transit-log-rule" />
      {/* Newest first, so the arrows read back in time. */}
      {[...bins].reverse().map((bin) => {
        const target = binTarget(bin);
        const count = bin.events.length;
        return (
          <button
            key={bin.id}
            type="button"
            tabIndex={-1}
            data-transit-item
            data-transit-event={bin.id}
            data-kind={bin.kind}
            data-count={count}
            data-session={target.event?.sessionId ?? undefined}
            data-terminal={target.event?.terminalId ?? undefined}
            aria-label={binLabel(bin, now)}
            onClick={() => open(target)}
            {...tipHandlers(tip, bin.id, () => ({
              id: bin.id,
              title: count > 1 ? `${count} events` : target.label,
              meta: formatAgo(now - target.ts),
              detail:
                count > 1
                  ? `Newest: ${target.label}${target.detail ? `, ${target.detail}` : ''}`
                  : target.detail,
            }))}
            className="transit-bin"
            style={{ transform: `translateX(${bin.x - binPx / 2}px)` }}
          >
            <span
              aria-hidden
              className={cx('transit-bar', fresh.has(bin.id) && 'transit-grow')}
              data-kind={bin.kind}
              style={{ height: binHeight(count) }}
            />
          </button>
        );
      })}
    </div>
  );
}

import { STATUS_TOKEN_META, type StatusToken } from '@yardmaster/protocol';
import { ChevronDown } from 'lucide-react';
import { createPreference, useMediaQuery, usePreference } from '../prefs.js';
import { tokenTone } from '../statusTokens.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';

/** Auto stays open on a desktop and folded on a phone, where the first screen is the board. */
export const legendPreference = createPreference(
  'yardmaster.legend',
  ['auto', 'open', 'closed'] as const,
  'auto',
);

const NARROW_QUERY = '(max-width: 767px), (pointer: coarse)';

/** The tokens in the order DESIGN.md §2.1 lists them; a legend has one line for each. */
export type LegendLines = Record<StatusToken, string>;
const ORDER: readonly StatusToken[] = [
  'needs_you',
  'failed',
  'running',
  'stale',
  'done_unseen',
  'quiet',
];

/**
 * What a playful layout's poses or trains mean, in the shared status vocabulary (DESIGN.md §2.1):
 * each token's mark and name beside how this layout acts it out. Folds to its button, per device.
 */
export function StatusLegend({
  lines,
  away = false,
}: {
  lines: LegendLines;
  /** Out of the way while something fills the stage (an Office room). */
  away?: boolean;
}) {
  const preference = usePreference(legendPreference);
  const narrow = useMediaQuery(NARROW_QUERY);
  const open = preference === 'auto' ? !narrow : preference === 'open';
  return (
    <section
      aria-label="Status legend"
      data-status-legend={open ? 'open' : 'closed'}
      inert={away || undefined}
      className={cx(
        'mb-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-control border border-line bg-bg-1/80 px-1 text-label transition-opacity duration-fast',
        !open && 'w-fit',
        away && 'pointer-events-none opacity-0',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => legendPreference.set(open ? 'closed' : 'open')}
        className="flex h-7 items-center gap-1 rounded-control px-2 font-medium text-text-2 outline-none transition-colors duration-fast hover:text-text-1 focus-visible:ring-2 focus-visible:ring-line-strong touch:min-h-11"
      >
        Legend
        <ChevronDown
          aria-hidden
          className={cx('size-3.5', open && 'rotate-180')}
          strokeWidth={1.75}
        />
      </button>
      {open && (
        <ul className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 py-1 pr-2 pl-2 sm:pl-0">
          {ORDER.map((token) => {
            const tone = tokenTone(token);
            const { label } = STATUS_TOKEN_META[token];
            return (
              <li key={token} data-legend-token={token} className="flex items-center gap-1.5">
                {tone !== 'idle' && <StatusDot tone={tone} label={label} />}
                <span className="font-medium text-text-1">{label}</span>
                <span className="text-text-2">{lines[token]}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

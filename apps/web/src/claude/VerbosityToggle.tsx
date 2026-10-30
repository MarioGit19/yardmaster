import { usePreference } from '../prefs.js';
import { cx } from '../ui/cx.js';
import { SegmentThumb, useSegmentThumb } from '../ui/SegmentThumb.js';
import { VERBOSITIES, verbosityPreference } from './verbosity.js';

const HINT = {
  summary: 'What was said, edits, subagents and failures',
  normal: 'The conversation and its tool calls',
  verbose: 'Also thinking and every tool’s full input and output',
} as const;

/** How much of the transcript to show. */
export function VerbosityToggle({ className }: { className?: string }) {
  const level = usePreference(verbosityPreference);
  const thumb = useSegmentThumb();
  return (
    <div
      role="radiogroup"
      aria-label="Transcript detail"
      data-verbosity={level}
      className={cx('flex shrink-0 rounded-control bg-bg-2 p-0.5', className)}
    >
      {VERBOSITIES.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={level === option}
          title={HINT[option]}
          onClick={(e) => {
            thumb.pick(e);
            verbosityPreference.set(option);
          }}
          className={cx(
            'relative h-5 rounded-chip px-2 text-meta capitalize transition-colors duration-fast touch:h-11 touch:min-w-11',
            level === option ? 'text-text-1' : 'text-text-3 hover:text-text-1',
          )}
        >
          {level === option && (
            <SegmentThumb
              layoutId={thumb.layoutId}
              byKeyboard={thumb.byKeyboard}
              className="bg-bg-1"
            />
          )}
          <span className="relative">{option}</span>
        </button>
      ))}
    </div>
  );
}

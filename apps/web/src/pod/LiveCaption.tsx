import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { dur, ease, slide, spring, useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';
import type { Caption, CaptionTone } from './model.js';

export const CAPTION_COLOR: Record<CaptionTone, string> = {
  active: 'text-text-1',
  wait: 'text-st-wait',
  err: 'text-st-err',
  rest: 'text-text-3',
};

/**
 * A session's live caption, DESIGN.md §4.10: a new action swaps in with a quick vertical slide
 * and one shimmer sweep across it. Reduced cross-fades; Off swaps.
 */
export function LiveCaption({ caption, className }: { caption: Caption; className?: string }) {
  // The caption on screen at load is not news: no sweep for it.
  const mounted = useRef(false);
  const still = useMotionLevel() !== 'full';
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <span
      title={caption.text}
      className={cx(
        'relative flex min-w-0 overflow-hidden',
        CAPTION_COLOR[caption.tone],
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={`${caption.tone}:${caption.text}`}
          data-caption={caption.tone}
          initial={{ opacity: 0, transform: slide(still, '80%') }}
          animate={{ opacity: 1, transform: slide(still, '0%'), transition: spring.snappy }}
          exit={{
            opacity: 0,
            transform: slide(still, '-80%'),
            transition: { duration: dur.fast, ease: ease.out },
          }}
          className={cx(
            'relative block min-w-0 truncate',
            mounted.current && caption.tone === 'active' && 'caption-sweep',
          )}
        >
          {caption.glyph && (
            <span aria-hidden className="mr-1.5 inline-block w-3 text-center font-mono">
              {caption.glyph}
            </span>
          )}
          {caption.text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

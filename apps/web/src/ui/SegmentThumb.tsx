import { motion } from 'motion/react';
import { type MouseEvent, useCallback, useId, useState } from 'react';
import { tabGlide } from '../motion.js';
import { cx } from './cx.js';

/**
 * A segmented control's thumb glide: one `layoutId` per control instance, so two toggles on the
 * same screen never trade thumbs, and a snap instead of a glide when the pick came from the keyboard.
 */
export function useSegmentThumb() {
  const layoutId = useId();
  const [byKeyboard, setByKeyboard] = useState(false);
  // detail 0: Enter or Space, not a pointer.
  const pick = useCallback((e: MouseEvent) => setByKeyboard(e.detail === 0), []);
  return { layoutId, byKeyboard, pick };
}

/** The selected segment's raised background. Render it inside the selected (relative) button. */
export function SegmentThumb({
  layoutId,
  byKeyboard,
  className,
}: {
  layoutId: string;
  byKeyboard: boolean;
  className: string;
}) {
  return (
    <motion.span
      layoutId={layoutId}
      transition={tabGlide(byKeyboard)}
      aria-hidden
      data-segment-thumb
      className={cx('absolute inset-0 rounded-chip shadow-raised', className)}
    />
  );
}

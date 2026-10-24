import { type HTMLMotionProps, motion, useDragControls } from 'motion/react';
import type { ReactNode, Ref } from 'react';
import { dur, ease, spring } from '../motion.js';
import { cx } from './cx.js';

/** A pull this far (px) or this fast (px/s) closes the sheet. */
const PULL_CLOSE_PX = 80;
const PULL_CLOSE_VELOCITY = 500;

export interface SheetPanelProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  children?: ReactNode;
  /** Called when the handle is pulled down far or fast enough. */
  onDismiss: () => void;
  ref?: Ref<HTMLDivElement>;
}

/**
 * A phone bottom sheet (DESIGN.md §11): rises on `smooth`, leaves at `dur.fast`, at most 90 dvh
 * and never under the on-screen keyboard (`--kb-inset`, from the phone shell). Pulling its handle
 * down closes it. Use it as the child of a Radix `Dialog.Content asChild`; the content scrolls
 * on its own.
 */
export function SheetPanel({ onDismiss, className, children, ref, ...props }: SheetPanelProps) {
  const drag = useDragControls();
  return (
    <motion.div
      ref={ref}
      data-sheet=""
      // `y` (not a transform string): Reduced drops it and only fades.
      initial={{ opacity: 0, y: '100%' }}
      animate={{ opacity: 1, y: 0, transition: spring.smooth }}
      exit={{ opacity: 0, y: '100%', transition: { duration: dur.fast, ease: ease.out } }}
      drag="y"
      dragListener={false}
      dragControls={drag}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.7 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > PULL_CLOSE_PX || info.velocity.y > PULL_CLOSE_VELOCITY) onDismiss();
      }}
      {...props}
      className={cx(
        'palette sheet-panel fixed inset-x-0 z-50 flex flex-col rounded-t-modal border border-line-strong border-b-0 shadow-raised outline-none',
        className,
      )}
    >
      {/* The handle: pulling it down closes the sheet. */}
      <div
        onPointerDown={(e) => drag.start(e)}
        data-sheet-handle=""
        className="flex h-6 shrink-0 cursor-grab touch-none select-none items-center justify-center active:cursor-grabbing"
      >
        <span aria-hidden className="h-1 w-10 rounded-full bg-line-strong" />
      </div>
      {children}
    </motion.div>
  );
}

import * as RadixPopover from '@radix-ui/react-popover';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactElement, ReactNode } from 'react';
import { dur, ease, spring } from '../motion.js';
import { cx } from './cx.js';

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Must forward its ref (a DOM element or a forwardRef component). */
  trigger: ReactElement;
  /** Accessible name of the popover. */
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
  /** Focus something other than the first focusable element on open. */
  onOpenAutoFocus?: (event: Event) => void;
  /** Focus something other than the trigger on close. */
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
  [data: `data-${string}`]: string | boolean | undefined;
}

/**
 * An anchored glass panel (Radix popover): scales in from the trigger on `snappy`, leaves at
 * `dur.fast`. `scale` is a plain key, so Reduced only fades it.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  label,
  side = 'bottom',
  align = 'end',
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
  children,
  ...data
}: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <AnimatePresence>
        {open && (
          <RadixPopover.Portal forceMount>
            <RadixPopover.Content
              asChild
              forceMount
              side={side}
              align={align}
              sideOffset={6}
              collisionPadding={16}
              aria-label={label}
              {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
              {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
            >
              <motion.div
                {...data}
                style={{ transformOrigin: 'var(--radix-popover-content-transform-origin)' }}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
                exit={{
                  opacity: 0,
                  scale: 0.98,
                  transition: { duration: dur.fast, ease: ease.out },
                }}
                className={cx(
                  'palette z-50 rounded-panel border border-line-strong p-3 shadow-raised outline-none',
                  className,
                )}
              >
                {children}
              </motion.div>
            </RadixPopover.Content>
          </RadixPopover.Portal>
        )}
      </AnimatePresence>
    </RadixPopover.Root>
  );
}

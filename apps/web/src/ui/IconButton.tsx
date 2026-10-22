import { type ComponentPropsWithRef, forwardRef, type ReactNode } from 'react';
import { type ButtonSize, type ButtonVariant, buttonClass } from './Button.js';
import { cx } from './cx.js';
import { Tooltip } from './Tooltip.js';

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  shortcut?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    shortcut,
    variant = 'ghost',
    size = 'md',
    tooltipSide,
    className,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-keyshortcuts={shortcut}
        className={cx(buttonClass(variant, size, { square: true }), className)}
        {...props}
      >
        {icon}
      </button>
    </Tooltip>
  );
});

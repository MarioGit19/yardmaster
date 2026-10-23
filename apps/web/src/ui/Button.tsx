import { type ComponentPropsWithRef, forwardRef } from 'react';
import { cx } from './cx.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-text-1 text-bg-0 hover:bg-text-2',
  secondary: 'border border-line bg-bg-2 text-text-1 shadow-raised hover:border-line-strong',
  ghost: 'text-text-2 hover:bg-bg-2 hover:text-text-1',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-3 text-label',
  md: 'h-8 gap-2 px-3 text-body-sm',
};

const SQUARE: Record<ButtonSize, string> = { sm: 'size-7', md: 'size-8' };

/** Shared by Button, IconButton and link-styled buttons. */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  { square = false } = {},
) {
  return cx(
    'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-control font-medium',
    'transition-[background-color,border-color,color,scale] duration-fast ease-out moving:active:scale-[0.97]',
    'disabled:pointer-events-none disabled:opacity-50',
    VARIANT[variant],
    square ? SQUARE[size] : SIZE[size],
  );
}

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(buttonClass(variant, size), className)}
      {...props}
    />
  );
});

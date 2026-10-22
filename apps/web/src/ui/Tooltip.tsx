import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';
import { Kbd } from './Kbd.js';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** Keyboard shortcut shown after the content. */
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Must forward its ref (a DOM element or a forwardRef component). */
  children: ReactElement;
}

export function Tooltip({ content, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="tooltip z-50 flex max-w-80 items-center gap-2 break-words rounded-control border border-line bg-bg-2 px-2 py-1 text-label text-text-1 shadow-raised"
        >
          {content}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

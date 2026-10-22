import type { ToastLevel } from '@c-board/protocol';
import { useEffect } from 'react';
import { Toaster, toast } from 'sonner';
import { useBoardClient } from '../data/index.js';
import { useTheme } from '../theme/theme.js';

const SHOW: Record<ToastLevel, typeof toast.info> = {
  info: toast.info,
  success: toast.success,
  warning: toast.warning,
  error: toast.error,
};

/** Sonner, restyled with our tokens, plus the bridge for server `toast` messages. */
export function Toasts() {
  const { theme } = useTheme();
  const client = useBoardClient();

  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type !== 'toast') return;
        const { level, title, body } = message.payload;
        SHOW[level](title, { description: body });
      }),
    [client],
  );

  return (
    <Toaster
      theme={theme}
      // Above the Pulse rail (AppShell publishes its height), so its newest events stay visible.
      position="bottom-right"
      gap={8}
      offset={{ right: 16, bottom: 'calc(var(--pulse-h, 0px) + 16px)' }}
      mobileOffset={{ left: 16, right: 16, bottom: 'calc(var(--pulse-h, 0px) + 16px)' }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'toast flex w-[var(--width)] items-start gap-3 rounded-control border border-line bg-bg-2 p-3 text-body-sm text-text-1 shadow-raised',
          title: 'font-medium',
          description: 'mt-0.5 text-label text-text-2',
          icon: 'mt-0.5 flex shrink-0 [&_svg]:size-4',
          content: 'min-w-0 flex-1',
          actionButton:
            'ml-auto h-7 shrink-0 self-center rounded-control border border-line bg-bg-1 px-2.5 text-label font-medium text-text-1 transition-colors duration-fast hover:border-line-strong',
          info: '[&_[data-icon]]:text-st-work-ink',
          success: '[&_[data-icon]]:text-st-ok-ink',
          warning: '[&_[data-icon]]:text-st-wait-ink',
          error: '[&_[data-icon]]:text-st-err-ink',
        },
      }}
    />
  );
}

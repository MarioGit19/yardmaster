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
      position="bottom-right"
      gap={8}
      offset={16}
      mobileOffset={16}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'toast flex w-[var(--width)] items-start gap-3 rounded-control border border-line bg-bg-2 p-3 text-body-sm text-text-1 shadow-raised',
          title: 'font-medium',
          description: 'mt-0.5 text-label text-text-2',
          icon: 'mt-0.5 flex shrink-0 [&_svg]:size-4',
          info: '[&_[data-icon]]:text-st-work',
          success: '[&_[data-icon]]:text-st-ok',
          warning: '[&_[data-icon]]:text-st-wait',
          error: '[&_[data-icon]]:text-st-err',
        },
      }}
    />
  );
}

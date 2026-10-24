import type { ToastLevel } from '@yardmaster/protocol';
import { useEffect } from 'react';
import { Toaster, toast } from 'sonner';
import { useBoardClient, useBoardStore } from '../data/index.js';
import { actionErrorText } from '../terminal/stack.js';
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
  const store = useBoardStore();

  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type !== 'toast') return;
        const { level, title, body, terminalId } = message.payload;
        const board = store.getState().board;
        const windowId = terminalId && board.terminals[terminalId]?.windowId;
        const editor = (windowId && board.windows[windowId]?.appName) || 'Cursor';
        SHOW[level](title, {
          description: body,
          ...(terminalId && {
            action: {
              label: `Focus in ${editor}`,
              onClick: async () => {
                const result = await client.action({ kind: 'terminal.focus', terminalId });
                if (!result.ok) toast.error(actionErrorText(result.error));
              },
            },
          }),
        });
      }),
    [client, store],
  );

  return (
    <Toaster
      theme={theme}
      // Lifted above the Pulse rail by a transform in index.css (AppShell publishes its height as
      // `--pulse-h`), so its newest events stay visible and a rail resize glides the toasts.
      position="bottom-right"
      gap={8}
      offset={{ right: 16, bottom: 16 }}
      mobileOffset={{ left: 16, right: 16, bottom: 16 }}
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
            'ml-auto h-7 shrink-0 self-center rounded-control touch:h-11 touch:min-w-11 border border-line bg-bg-1 px-2.5 text-label font-medium text-text-1 transition-[border-color,scale] duration-fast ease-out hover:border-line-strong moving:active:scale-[0.97]',
          info: '[&_[data-icon]]:text-st-work-ink',
          success: '[&_[data-icon]]:text-st-ok-ink',
          warning: '[&_[data-icon]]:text-st-wait-ink',
          error: '[&_[data-icon]]:text-st-err-ink',
        },
      }}
    />
  );
}

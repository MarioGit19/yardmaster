import type { LinkStatus } from './editor-link.js';

export const STATUS_TEXT = '$(pulse) Yardmaster';

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s === 1 ? '1 second' : `${s} seconds`;
}

/** Status bar tooltip for the link state; clicking the item opens the dashboard. */
export function statusTooltip(status: LinkStatus | { kind: 'legacy' }, port: number): string {
  const action = 'Click to open the dashboard.';
  switch (status.kind) {
    case 'legacy':
      return 'Yardmaster: waiting. The old c-board extension is still connected; uninstall it and reload the window.';
    case 'stopped':
      return `Yardmaster: off (yardmaster.enabled is false). ${action}`;
    case 'connecting':
      return `Yardmaster: connecting to 127.0.0.1:${port}…`;
    case 'connected':
      return `Yardmaster: connected to 127.0.0.1:${port}. ${action}`;
    case 'disconnected':
      return `Yardmaster: disconnected, ${status.reason}. Retrying in ${seconds(status.retryInMs)}. ${action}`;
    case 'replaced':
      return 'Yardmaster: disconnected, another connection for this window took over. Run "Yardmaster: Reconnect" to retry.';
  }
}

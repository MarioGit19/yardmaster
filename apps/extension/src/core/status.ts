import type { LinkStatus } from './editor-link.js';

export const STATUS_TEXT = '$(pulse) c-board';

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s === 1 ? '1 second' : `${s} seconds`;
}

/** Status bar tooltip for the link state; clicking the item opens the dashboard. */
export function statusTooltip(status: LinkStatus, port: number): string {
  const action = 'Click to open the dashboard.';
  switch (status.kind) {
    case 'stopped':
      return `c-board: off (cboard.enabled is false). ${action}`;
    case 'connecting':
      return `c-board: connecting to 127.0.0.1:${port}…`;
    case 'connected':
      return `c-board: connected to 127.0.0.1:${port}. ${action}`;
    case 'disconnected':
      return `c-board: disconnected, ${status.reason}. Retrying in ${seconds(status.retryInMs)}. ${action}`;
    case 'replaced':
      return 'c-board: disconnected, another connection for this window took over. Run "c-board: Reconnect" to retry.';
  }
}

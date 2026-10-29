import { describe, expect, it } from 'vitest';
import { statusTooltip } from './status.js';

describe('statusTooltip', () => {
  it('describes each link state', () => {
    expect(statusTooltip({ kind: 'connected' })).toBe(
      'Yardmaster: connected to the local server. Click to open the dashboard.',
    );
    expect(statusTooltip({ kind: 'connecting' })).toContain('connecting to the local server');
    expect(statusTooltip({ kind: 'stopped' })).toContain('yardmaster.enabled is false');
    expect(statusTooltip({ kind: 'replaced' })).toContain('Yardmaster: Reconnect');
    expect(statusTooltip({ kind: 'legacy' })).toContain('uninstall it and reload');
  });

  it('rounds the retry delay to whole seconds', () => {
    const tip = (retryInMs: number) =>
      statusTooltip({ kind: 'disconnected', reason: 'the server is not running', retryInMs });
    expect(tip(400)).toContain('the server is not running. Retrying in 1 second.');
    expect(tip(29_600)).toContain('Retrying in 30 seconds.');
  });
});

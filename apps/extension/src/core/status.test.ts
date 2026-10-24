import { describe, expect, it } from 'vitest';
import { statusTooltip } from './status.js';

describe('statusTooltip', () => {
  it('describes each link state', () => {
    expect(statusTooltip({ kind: 'connected' }, 4317)).toBe(
      'Yardmaster: connected to 127.0.0.1:4317. Click to open the dashboard.',
    );
    expect(statusTooltip({ kind: 'connecting' }, 5000)).toContain('connecting to 127.0.0.1:5000');
    expect(statusTooltip({ kind: 'stopped' }, 4317)).toContain('yardmaster.enabled is false');
    expect(statusTooltip({ kind: 'replaced' }, 4317)).toContain('Yardmaster: Reconnect');
    expect(statusTooltip({ kind: 'legacy' }, 4317)).toContain('uninstall it and reload');
  });

  it('rounds the retry delay to whole seconds', () => {
    const tip = (retryInMs: number) =>
      statusTooltip({ kind: 'disconnected', reason: 'the server is not running', retryInMs }, 4317);
    expect(tip(400)).toContain('the server is not running. Retrying in 1 second.');
    expect(tip(29_600)).toContain('Retrying in 30 seconds.');
  });
});

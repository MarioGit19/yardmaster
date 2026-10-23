import { describe, expect, it } from 'vitest';
import { claudeTerminalLabel, claudeTerminalTitle, claudeTerminalView } from './claudeTerminal.js';

describe('Claude terminals', () => {
  it('are titled after their session and labelled with what Claude does', () => {
    expect(claudeTerminalTitle({ title: '  Checkout fix ' })).toBe('Checkout fix');
    expect(claudeTerminalTitle({ title: null })).toBe('Claude');
    expect(claudeTerminalLabel('acme-shop', 'Waiting for approval: Bash(pnpm test)')).toBe(
      'acme-shop, Claude, waiting for approval: Bash(pnpm test)',
    );
  });

  it('remember chat or raw per terminal, chat by default', () => {
    let changes = 0;
    const stop = claudeTerminalView.subscribe(() => changes++);
    expect(claudeTerminalView.get('t-a')).toBe('chat');
    claudeTerminalView.set('t-a', 'raw');
    claudeTerminalView.set('t-a', 'raw');
    expect(claudeTerminalView.get('t-a')).toBe('raw');
    expect(claudeTerminalView.get('t-b')).toBe('chat');
    expect(changes).toBe(1);
    stop();
  });
});

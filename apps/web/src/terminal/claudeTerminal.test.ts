import { describe, expect, it } from 'vitest';
import { claudeTerminalLabel, claudeTerminalView } from './claudeTerminal.js';

describe('Claude terminals', () => {
  it('are labelled with their name and what Claude does', () => {
    expect(claudeTerminalLabel('agent', 'Waiting for approval: Bash(pnpm test)')).toBe(
      'agent, Claude, waiting for approval: Bash(pnpm test)',
    );
    // A name that already says Claude ("Claude 2") isn't followed by a second "Claude".
    expect(claudeTerminalLabel('Claude 2', 'Running Bash')).toBe('Claude 2, running Bash');
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

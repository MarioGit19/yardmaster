import { CLAUDE_NAME } from '@yardmaster/protocol';
import { useSyncExternalStore } from 'react';

/** What Claude Code's TUI takes as "stop": its own interrupt key. */
export const ESC = '\u001b';

/** A Claude terminal's pane: the session's chat, or the TUI's raw output. */
export type ClaudeTerminalView = 'chat' | 'raw';

// The chat/raw choice per terminal, for the page's lifetime (not persisted).
const views = new Map<string, ClaudeTerminalView>();
const listeners = new Set<() => void>();

export const claudeTerminalView = {
  get: (terminalId: string): ClaudeTerminalView => views.get(terminalId) ?? 'chat',
  set(terminalId: string, view: ClaudeTerminalView) {
    if (claudeTerminalView.get(terminalId) === view) return;
    views.set(terminalId, view);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useClaudeTerminalView(terminalId: string): ClaudeTerminalView {
  const get = () => claudeTerminalView.get(terminalId);
  return useSyncExternalStore(claudeTerminalView.subscribe, get, get);
}

/** "Claude 2, waiting for approval: Bash(pnpm test)": its name, then what Claude does. */
export function claudeTerminalLabel(name: string, caption: string): string {
  const what = caption.charAt(0).toLowerCase() + caption.slice(1);
  return name.startsWith(CLAUDE_NAME) ? `${name}, ${what}` : `${name}, ${CLAUDE_NAME}, ${what}`;
}

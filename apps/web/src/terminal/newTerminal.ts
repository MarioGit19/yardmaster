import type { BoardState, Terminal } from '@c-board/protocol';
import { useSyncExternalStore } from 'react';

/** Chips for the project's recent commands in the new-terminal popover. */
export const MAX_RECENT_COMMANDS = 5;
/** The chip that starts Claude Code in the new terminal. */
export const CLAUDE_COMMAND = 'claude';

const isClaude = (command: string) => command === CLAUDE_COMMAND || command.startsWith('claude ');

/**
 * The project's distinct recent command lines, newest first: what someone is likely to start
 * again in a new terminal. Interactive apps, `claude` (it has its own chip) and blanks are left out.
 */
export function recentCommands(
  board: Pick<BoardState, 'terminals' | 'executions'>,
  projectId: string,
  max = MAX_RECENT_COMMANDS,
): string[] {
  const runs = Object.values(board.executions)
    .filter((e) => board.terminals[e.terminalId]?.projectId === projectId && !e.interactive)
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const commands: string[] = [];
  for (const run of runs) {
    const command = run.commandLine.replace(/\s+/g, ' ').trim();
    if (command === '' || isClaude(command) || commands.includes(command)) continue;
    commands.push(command);
    if (commands.length === max) break;
  }
  return commands;
}

/** The terminal that showed up since `known` was taken: the newest open one not in it. */
export function arrivedTerminal(
  known: ReadonlySet<string>,
  terminals: readonly Pick<Terminal, 'id' | 'state' | 'createdAt'>[],
): string | null {
  let found: Pick<Terminal, 'id' | 'createdAt'> | null = null;
  for (const terminal of terminals) {
    if (terminal.state !== 'open' || known.has(terminal.id)) continue;
    if (!found || terminal.createdAt > found.createdAt) found = terminal;
  }
  return found?.id ?? null;
}

// A request from ⌘K or a pod's menu to open the popover in the project's focus view.
let requested: string | null = null;
const listeners = new Set<() => void>();

export const newTerminalRequest = {
  get: () => requested,
  set(projectId: string | null) {
    requested = projectId;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Whether someone asked to open a new terminal in `projectId` and the popover hasn't yet. */
export function useNewTerminalRequest(projectId: string): boolean {
  const current = useSyncExternalStore(newTerminalRequest.subscribe, newTerminalRequest.get);
  return current === projectId;
}

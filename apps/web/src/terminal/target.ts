import { useSyncExternalStore } from 'react';

/** A terminal someone asked to see (from ⌘K): the focus view's stack opens it once. */
export interface TerminalTarget {
  projectId: string;
  terminalId: string;
}

let target: TerminalTarget | null = null;
const listeners = new Set<() => void>();

export const terminalTarget = {
  get: () => target,
  set(next: TerminalTarget | null) {
    target = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The pending target for `projectId`, or null. */
export function useTerminalTarget(projectId: string): string | null {
  const current = useSyncExternalStore(terminalTarget.subscribe, terminalTarget.get);
  return current?.projectId === projectId ? current.terminalId : null;
}

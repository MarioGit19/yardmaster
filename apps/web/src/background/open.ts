import { useSyncExternalStore } from 'react';

// Which sessions show their Background list open in the Claude panel. A row's background line
// opens it before it navigates there; kept in memory for the page's lifetime.

const open = new Set<string>();
/** Bumped each time a row asks to show a list, so narrow screens switch to the Claude tab. */
let requests = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const backgroundOpen = {
  has: (sessionId: string) => open.has(sessionId),
  set(sessionId: string, value: boolean) {
    if (value === open.has(sessionId)) return;
    if (value) open.add(sessionId);
    else open.delete(sessionId);
    emit();
  },
  /** Opens the list and asks the focus view to show it. */
  request(sessionId: string) {
    open.add(sessionId);
    requests += 1;
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useBackgroundOpen(sessionId: string): boolean {
  return useSyncExternalStore(
    backgroundOpen.subscribe,
    () => open.has(sessionId),
    () => false,
  );
}

export function useBackgroundRequests(): number {
  return useSyncExternalStore(
    backgroundOpen.subscribe,
    () => requests,
    () => 0,
  );
}

import { type SessionHistoryEntry, SessionHistoryResponse } from '@c-board/protocol';
import { useEffect, useState } from 'react';

export type HistoryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; sessions: SessionHistoryEntry[] };

/** Past sessions of a project from the server (F17); throws on a failed or malformed reply. */
export async function fetchSessionHistory(
  projectId: string,
  signal?: AbortSignal,
): Promise<SessionHistoryEntry[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`history request failed: ${res.status}`);
  return SessionHistoryResponse.parse(await res.json()).sessions;
}

/**
 * Loads a project's history, again whenever `refreshKey` changes (a session ended) or
 * `retry` is called. A refresh keeps showing the previous list until the new one lands.
 */
export function useSessionHistory(
  projectId: string,
  refreshKey: unknown,
): { state: HistoryState; retry: () => void } {
  // Tagged with its project, so a different project starts from a clean slate.
  const [loaded, setLoaded] = useState<{ projectId: string; state: HistoryState } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and attempt only trigger a reload
  useEffect(() => {
    const controller = new AbortController();
    fetchSessionHistory(projectId, controller.signal).then(
      (sessions) => setLoaded({ projectId, state: { status: 'ready', sessions } }),
      () => {
        if (controller.signal.aborted) return;
        setLoaded((prev) =>
          prev?.projectId === projectId && prev.state.status === 'ready'
            ? prev
            : { projectId, state: { status: 'error' } },
        );
      },
    );
    return () => controller.abort();
  }, [projectId, refreshKey, attempt]);

  return {
    state: loaded?.projectId === projectId ? loaded.state : { status: 'loading' },
    retry: () => {
      setLoaded(null);
      setAttempt((n) => n + 1);
    },
  };
}

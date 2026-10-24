import type { HooksStatusResponse, ServerStatus } from '@yardmaster/protocol';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * `/api/status`, polled every `pollMs` while `pollMs` is set (null fetches once), and only while
 * `enabled`. Resolves to `'error'` when the server can't answer, so callers never wait forever.
 */
export function useServerStatus(
  pollMs: number | null,
  enabled = true,
): ServerStatus | null | 'error' {
  const [status, setStatus] = useState<ServerStatus | null | 'error'>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.status(controller.signal).then(
        (next) => setStatus(next),
        () => {
          if (!controller.signal.aborted) setStatus((prev) => (prev === null ? 'error' : prev));
        },
      );
      if (pollMs !== null) timer = setTimeout(load, pollMs);
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pollMs, enabled]);
  return status;
}

export type HooksState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; hooks: HooksStatusResponse };

/** The hooks in Claude's settings.json, with a `reload` for after an install. */
export function useHooksStatus(): { state: HooksState; reload: () => void } {
  const [state, setState] = useState<HooksState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt only triggers a reload
  useEffect(() => {
    const controller = new AbortController();
    api.hooks(controller.signal).then(
      (hooks) => setState({ status: 'ready', hooks }),
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [attempt]);
  return { state, reload: useCallback(() => setAttempt((n) => n + 1), []) };
}

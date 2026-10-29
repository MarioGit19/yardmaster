import type { BrowserSession } from '@yardmaster/protocol';
import { Monitor, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { markSignedOut, sessionSecret } from '../auth/session.js';
import { formatDateTime, formatWhen } from '../time.js';
import { Button } from '../ui/Button.js';
import { api } from './api.js';
import { onRemoteHost } from './remoteHost.js';

const NOW_TICK_MS = 30_000;

function useSessions() {
  const [sessions, setSessions] = useState<BrowserSession[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api.sessions(signal);
      setSessions(res.sessions);
      setFailed(false);
    } catch {
      if (!signal?.aborted) setFailed(true);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);
  return { sessions, failed, reload };
}

/**
 * Settings → Data and security: every browser signed in to the board, on this computer and paired
 * phones, each with its own session. Signing one out closes its open board at once.
 */
export function SessionsRow() {
  const { sessions, failed, reload } = useSessions();
  const [now, setNow] = useState(() => Date.now());
  const [revoking, setRevoking] = useState<string | null>(null);
  const remote = onRemoteHost();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const revoke = async (session: BrowserSession) => {
    setRevoking(session.id);
    const used = sessionSecret();
    try {
      await api.revokeSession(session.id);
      if (session.current) {
        markSignedOut(used);
        return;
      }
      toast.success(`${session.name} signed out`, {
        description:
          session.kind === 'remote'
            ? 'Pair it again to use it.'
            : 'It signs in again with a new link.',
      });
    } catch {
      toast.error('Could not sign that browser out');
    } finally {
      setRevoking(null);
      await reload();
    }
  };

  let summary: string;
  if (failed) summary = 'Could not load the signed-in browsers.';
  else if (sessions === null) summary = 'Loading…';
  else
    summary =
      'Each browser and phone has its own sign-in. Sign out any you don’t recognise; phones also sign out after 30 days unused.';

  return (
    <div className="flex flex-col gap-3 p-5" data-setting="sessions">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-body text-text-1">Signed-in browsers</h3>
        <p className="text-label text-text-2">{summary}</p>
      </div>
      {sessions && sessions.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-bg-0">
          {sessions.map((session) => {
            const Icon = session.kind === 'remote' ? Smartphone : Monitor;
            return (
              <li
                key={session.id}
                data-session={session.id}
                data-current={session.current || undefined}
                className="flex min-w-0 items-center gap-3 py-2 pr-2 pl-3"
              >
                <Icon aria-hidden className="size-4 shrink-0 stroke-[1.5] text-text-3" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="min-w-0 break-words text-body-sm text-text-1">
                      {session.name}
                    </span>
                    {session.current && (
                      <span className="shrink-0 rounded-chip bg-bg-2 px-1.5 text-meta text-text-2">
                        This browser
                      </span>
                    )}
                  </span>
                  <span className="text-meta text-text-3 tabular-nums">
                    {session.kind === 'remote' ? 'Phone' : 'This computer'}
                    {' · '}
                    <span title={formatDateTime(session.createdAt)}>
                      signed in {formatWhen(session.createdAt, now)}
                    </span>
                    {' · '}
                    <span title={formatDateTime(session.lastSeenAt)}>
                      seen {formatWhen(session.lastSeenAt, now)}
                    </span>
                  </span>
                </span>
                {/* A phone may sign out only itself; the Mac signs out the others. */}
                {(!remote || session.current) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoking === session.id}
                    onClick={() => void revoke(session)}
                  >
                    {revoking === session.id ? 'Signing out…' : 'Sign out'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

import { SEARCH_MAX_MB, type SearchIndexStatus, type SearchMaxMb } from '@yardmaster/protocol';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { countOf } from '../plural.js';
import { Button } from '../ui/Button.js';
import { Segmented, SettingRow } from '../views/SettingsView.js';
import { api } from './api.js';
import type { ServerSettings } from './boardSettings.js';

const POLL_MS = 2_000;
const MB = 1024 * 1024;
const ON_OFF = ['off', 'on'] as const;
const ON_OFF_LABEL = { off: 'Off', on: 'On' } as const;

const MAX_OPTIONS = SEARCH_MAX_MB.map(String) as `${SearchMaxMb}`[];
const MAX_LABEL = Object.fromEntries(
  SEARCH_MAX_MB.map((mb) => [mb, mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`]),
) as Record<`${SearchMaxMb}`, string>;

export function formatIndexSize(bytes: number): string {
  if (bytes === 0) return 'Empty';
  if (bytes < MB) return 'Under 1 MB';
  return `About ${Math.round(bytes / MB).toLocaleString()} MB`;
}

function useIndexStatus() {
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await api.searchIndex(signal));
    } catch {
      // The row keeps its last reading.
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);
  const indexing = status?.indexing === true;
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [indexing, reload]);
  return { status, reload };
}

/** Settings → Data and security: what the transcript index holds, its limit, rebuild and clear. */
export function SearchIndexRows({ server: { settings, update } }: { server: ServerSettings }) {
  const { status, reload } = useIndexStatus();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (run: () => Promise<unknown>, done: string, failed: string) => {
    setBusy(true);
    try {
      await run();
      toast.success(done);
    } catch {
      toast.error(failed);
    } finally {
      setBusy(false);
      setConfirming(false);
      await reload();
    }
  };

  const summary =
    status === null
      ? 'Loading…'
      : [
          formatIndexSize(status.bytes),
          `${countOf(status.sessions, 'session')}, ${countOf(status.messages, 'message')}`,
          status.indexing ? 'indexing now' : null,
          status.trimmed > 0
            ? `${countOf(status.trimmed, 'older session')} dropped to fit the limit`
            : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <>
      <SettingRow
        title="Search index"
        data="search-index"
        description={
          <>
            <span className="block">
              Every transcript, in a local database that never leaves this computer.
            </span>
            <span data-search-index-summary className="block tabular-nums">
              {summary}
            </span>
          </>
        }
      >
        <div className="flex shrink-0 gap-2">
          {confirming ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                data-search-clear-confirm
                onClick={() =>
                  void act(
                    () => api.clearSearchIndex(),
                    'Search index cleared',
                    'Could not clear the index',
                  )
                }
              >
                Clear index
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || status?.indexing === true}
                data-search-rebuild
                onClick={() =>
                  void act(
                    () => api.rebuildSearchIndex(),
                    'Rebuilding the search index',
                    'Could not rebuild the index',
                  )
                }
              >
                Rebuild
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                data-search-clear
                onClick={() => setConfirming(true)}
              >
                Clear
              </Button>
            </>
          )}
        </div>
      </SettingRow>
      <SettingRow
        title="Search index limit"
        data="search-limit"
        description="Past this size the oldest sessions leave the index. Your transcripts aren’t touched."
      >
        <Segmented
          label="Search index limit"
          options={MAX_OPTIONS}
          labels={MAX_LABEL}
          value={settings ? (`${settings.searchMaxMb}` as const) : '500'}
          onChange={(value) =>
            void update(
              { searchMaxMb: Number(value) as SearchMaxMb },
              'Could not save the limit',
            ).then(() => reload())
          }
          disabled={settings === null}
        />
      </SettingRow>
      <SettingRow
        title="Index tool calls"
        data="search-tools"
        description="Also index tool inputs and outputs, which makes the index much larger. Rebuild to include past sessions."
      >
        <Segmented
          label="Index tool calls"
          options={ON_OFF}
          labels={ON_OFF_LABEL}
          value={settings?.searchIncludeTools ? 'on' : 'off'}
          onChange={(value) =>
            void update({ searchIncludeTools: value === 'on' }, 'Could not save the setting')
          }
          disabled={settings === null}
        />
      </SettingRow>
    </>
  );
}

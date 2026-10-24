import type { PortShare, PortSharesResponse } from '@yardmaster/protocol';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { api } from '../settings/api.js';

/** How often the shared ports are checked while something shows them. */
export const SHARES_POLL_MS = 10_000;

type Shares = PortSharesResponse | null;

function createSharesStore() {
  const listeners = new Set<() => void>();
  let value: Shares = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading: Promise<void> | null = null;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const poll = () => {
    clearTimeout(timer);
    if (listeners.size === 0) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
    timer = setTimeout(poll, SHARES_POLL_MS);
  };
  const load = (): Promise<void> => {
    loading ??= api
      .portShares()
      .then(
        (next) => store.set(next),
        () => {},
      )
      .finally(() => {
        loading = null;
      });
    return loading;
  };
  const store = {
    get: () => value,
    set(next: Shares) {
      value = next;
      notify();
    },
    load,
    /** A share the server just made or reported. */
    upsert(share: PortShare) {
      if (!value) return;
      const shares = [...value.shares.filter((s) => s.port !== share.port), share];
      store.set({ ...value, shares: shares.sort((a, b) => a.port - b.port) });
    },
    remove(port: number) {
      if (!value) return;
      store.set({ ...value, shares: value.shares.filter((s) => s.port !== port) });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) poll();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) clearTimeout(timer);
      };
    },
  };
  return store;
}

/** The ports on the tailnet (12.6e2), shared by every port chip on screen. */
export const portShares = createSharesStore();

export const usePortShares = (): Shares =>
  useSyncExternalStore(portShares.subscribe, portShares.get, () => null);

/** The share for a port, if it is on the phone. */
export function usePortShare(port: number): PortShare | undefined {
  const shares = usePortShares();
  return shares?.shares.find((s) => s.port === port);
}

/** "Open on phone" can be offered: Tailscale is there and phone access is set up. */
export const useCanShare = (): boolean => usePortShares()?.available === true;

/** The sheet with a port's phone link (null when closed). */
function createRequestStore() {
  const listeners = new Set<() => void>();
  let value: number | null = null;
  return {
    get: () => value,
    set(next: number | null) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const portShareRequest = createRequestStore();

export async function sharePort(port: number): Promise<PortShare> {
  const share = await api.sharePort(port);
  portShares.upsert(share);
  return share;
}

export async function stopSharing(port: number): Promise<void> {
  await api.unsharePort(port);
  portShares.remove(port);
}

export async function copyText(text: string, what = text): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  } catch {
    toast.error(`Couldn't copy ${what}`);
  }
}

export const VITE_HINT =
  'The dev server blocked the tailnet name. For Vite, add it to server.allowedHosts (".ts.net" allows any tailnet name), then reload.';

/**
 * On the phone itself: opens the port's tailnet URL in a new tab, sharing it first. The tab
 * opens right away, inside the tap, so the browser doesn't block it while the share runs.
 */
export async function openOnPhone(port: number, existing: PortShare | undefined): Promise<void> {
  if (existing) {
    window.open(existing.url, '_blank', 'noopener');
    return;
  }
  const tab = window.open('', '_blank');
  try {
    const share = await sharePort(port);
    if (tab) {
      tab.opener = null;
      tab.location.href = share.url;
    } else {
      window.location.href = share.url;
    }
    if (share.hint === 'vite_blocked')
      toast.warning(`:${port} answered “Blocked request”`, { description: VITE_HINT });
  } catch (err) {
    tab?.close();
    toast.error(`Could not share :${port}`, {
      description: err instanceof Error ? err.message : undefined,
    });
  }
}

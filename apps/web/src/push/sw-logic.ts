import type { PushPayload } from '@yardmaster/protocol';
import { SESSION_HEADER } from '@yardmaster/protocol/session-keys';

// The service worker's logic, kept free of imports with runtime code: `sw.ts` bundles it into one
// classic script, and the tests run it without a worker.

type ShowPayload = Extract<PushPayload, { type: 'show' }>;

/** What a shown notification keeps for its click. */
export interface NotificationData {
  url: string;
  request: string | null;
  approvalId: string | null;
}

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A push's payload, or null for anything the board didn't send. */
export function readPayload(data: unknown): PushPayload | null {
  if (!isObj(data)) return null;
  if (data.type === 'close') {
    const tag = str(data.tag);
    const request = str(data.request);
    return tag !== null && request !== null ? { type: 'close', tag, request } : null;
  }
  if (data.type !== 'show') return null;
  const title = str(data.title);
  const tag = str(data.tag);
  if (title === null || tag === null) return null;
  return {
    type: 'show',
    kind: (str(data.kind) ?? 'test') as ShowPayload['kind'],
    title,
    body: str(data.body) ?? '',
    tag,
    url: str(data.url) ?? '/',
    request: str(data.request),
    approvalId: str(data.approvalId),
    ts: typeof data.ts === 'number' ? data.ts : 0,
  };
}

export interface ShowOptions {
  body: string;
  tag: string;
  icon: string;
  badge: string;
  data: NotificationData;
  renotify: boolean;
  requireInteraction: boolean;
  actions: { action: 'allow' | 'deny'; title: string }[];
}

/** `showNotification`'s options: approvals in away mode get Allow / Deny. */
export function showOptions(payload: ShowPayload): ShowOptions {
  const needsYou = payload.kind === 'needs_you';
  return {
    body: payload.body,
    tag: payload.tag,
    icon: '/apple-touch-icon.png',
    badge: '/favicon.png',
    data: { url: payload.url, request: payload.request, approvalId: payload.approvalId },
    // A later event replaces the project's notification; only one that needs you alerts again.
    renotify: needsYou,
    requireInteraction: needsYou,
    actions: payload.approvalId
      ? [
          { action: 'allow', title: 'Allow' },
          { action: 'deny', title: 'Deny' },
        ]
      : [],
  };
}

function readData(data: unknown): NotificationData {
  if (!isObj(data)) return { url: '/', request: null, approvalId: null };
  return {
    url: str(data.url) ?? '/',
    request: str(data.request),
    approvalId: str(data.approvalId),
  };
}

/** Closes the shown notifications about `request`: it was answered somewhere else. */
export function closeAnswered(
  notifications: readonly { data: unknown; close(): void }[],
  request: string,
): number {
  let closed = 0;
  for (const notification of notifications) {
    if (readData(notification.data).request !== request) continue;
    notification.close();
    closed++;
  }
  return closed;
}

export interface WindowLike {
  url: string;
  focused: boolean;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface ClickDeps {
  /** The board's origin (the worker's own). */
  origin: string;
  fetch(url: string, init: RequestInit): Promise<{ ok: boolean }>;
  /** This browser's session secret (the page keeps a copy in IndexedDB), or null. */
  session(): Promise<string | null>;
  windows(): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
}

/** The message a board tab gets to open a route (`main` listens for it). */
export const OPEN_MESSAGE = 'yardmaster.open';

/** A same-origin board route; anything else opens the overview. */
export function boardRoute(url: string, origin: string): string {
  try {
    const target = new URL(url, origin);
    if (target.origin !== origin) return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}

export type ClickOutcome = 'decided' | 'focused' | 'opened';

/**
 * A notification click. Allow / Deny decide the approval on the Attention Center's path, without
 * opening anything; if that fails (already answered, signed out) the board opens on the request.
 * Otherwise an open board tab is focused and sent to the deep link, or a new one opens.
 */
export async function routeClick(
  action: string,
  data: unknown,
  deps: ClickDeps,
): Promise<ClickOutcome> {
  const { url, approvalId } = readData(data);
  if ((action === 'allow' || action === 'deny') && approvalId) {
    try {
      const secret = await deps.session();
      const res = await deps.fetch(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          'content-type': 'application/json',
          ...(secret === null ? {} : { [SESSION_HEADER]: secret }),
        },
        body: JSON.stringify({ decision: action }),
      });
      if (res.ok) return 'decided';
    } catch {
      // Offline or the board is down: open it instead.
    }
  }
  const route = boardRoute(url, deps.origin);
  const windows = (await deps.windows()).filter((w) => {
    try {
      return new URL(w.url).origin === deps.origin;
    } catch {
      return false;
    }
  });
  const target = windows.find((w) => w.focused) ?? windows[0];
  if (target) {
    await target.focus();
    target.postMessage({ type: OPEN_MESSAGE, url: route });
    return 'focused';
  }
  await deps.openWindow(route);
  return 'opened';
}

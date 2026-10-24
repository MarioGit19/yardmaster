import { PushSubscribeResponse } from '@yardmaster/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import type { BoardClient } from '../data/client.js';
import { useBoardClient } from '../data/index.js';
import { api } from '../settings/api.js';

// Web Push on this browser (12.6e3): the service worker, the subscription and its id on the server.

export const SW_URL = '/sw.js';
/** `sw-logic`'s message to open a route. Not imported: that would pull it into a shared chunk. */
export const OPEN_MESSAGE = 'yardmaster.open';
const PUSH_ID_KEY = 'yardmaster.push.id';

/**
 * Why push can't be turned on here, or 'ok'. iOS only offers it to a board added to the home
 * screen (16.4+); every browser needs a secure context (HTTPS, or localhost).
 */
export type PushSupport = 'ok' | 'insecure' | 'ios_home_screen' | 'unsupported';

export interface PushEnvironment {
  isSecureContext: boolean;
  userAgent: string;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** Opened from the home screen (`display-mode: standalone`, or Safari's `navigator.standalone`). */
  standalone: boolean;
}

export function pushSupport(env: PushEnvironment): PushSupport {
  if (!env.isSecureContext) return 'insecure';
  const ios = /iPhone|iPad|iPod/.test(env.userAgent);
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return 'ok';
  if (ios && !env.standalone) return 'ios_home_screen';
  return 'unsupported';
}

export function browserPushEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    isSecureContext: window.isSecureContext,
    userAgent: nav.userAgent,
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: 'PushManager' in window,
    hasNotification: typeof Notification !== 'undefined',
    standalone:
      nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
  };
}

const listeners = new Set<() => void>();
const readId = (): string | null => {
  try {
    return localStorage.getItem(PUSH_ID_KEY);
  } catch {
    return null;
  }
};
let pushId = readId();

function setPushId(next: string | null): void {
  if (next === pushId) return;
  pushId = next;
  try {
    if (next === null) localStorage.removeItem(PUSH_ID_KEY);
    else localStorage.setItem(PUSH_ID_KEY, next);
  } catch {
    // The subscription still works; only the visibility rule loses track of this browser.
  }
  for (const listener of listeners) listener();
}

/** This browser's subscription id on the server, or null when push is off here. */
export const pushIdStore = {
  get: () => pushId,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function usePushId(): string | null {
  return useSyncExternalStore(pushIdStore.subscribe, pushIdStore.get);
}

/** The VAPID key as the bytes `PushManager.subscribe` wants. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  return navigator.serviceWorker.ready;
}

async function sendSubscription(subscription: PushSubscription): Promise<string> {
  const res = await fetch('/api/push/subscriptions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) throw new Error(`subscribing failed: ${res.status}`);
  return PushSubscribeResponse.parse(await res.json()).id;
}

export type EnableResult = 'enabled' | 'denied' | 'failed';

/** Asks for permission, subscribes this browser and registers it with the board. */
export async function enablePush(): Promise<EnableResult> {
  const permission =
    Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== 'granted') return 'denied';
  try {
    const info = await api.push();
    const reg = await registration();
    const subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(info.publicKey),
      }));
    setPushId(await sendSubscription(subscription));
    return 'enabled';
  } catch {
    return 'failed';
  }
}

/** Unsubscribes this browser and forgets it on the board. */
export async function disablePush(): Promise<void> {
  const id = pushId;
  setPushId(null);
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    // Already gone.
  }
  if (id) await api.removePushDevice(id).catch(() => {});
}

/**
 * On start: a browser that has a subscription re-registers it (the board may have dropped it, or
 * the browser rotated it), and one the board no longer knows turns push off here.
 */
export async function syncPush(env: PushEnvironment = browserPushEnvironment()): Promise<void> {
  if (pushSupport(env) !== 'ok' || Notification.permission !== 'granted') {
    if (pushId !== null && pushSupport(env) === 'ok') setPushId(null);
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const subscription = await reg?.pushManager.getSubscription();
    if (!subscription) {
      setPushId(null);
      return;
    }
    setPushId(await sendSubscription(subscription));
  } catch {
    // Offline or signed out: try again next time.
  }
}

/**
 * Tells the board whether this tab is visible and focused, and routes notification clicks the
 * service worker hands to an open tab.
 */
export function usePushPresence(client: BoardClient): void {
  const id = usePushId();
  useEffect(() => {
    const report = () =>
      client.setPresence(document.visibilityState === 'visible' && document.hasFocus(), id);
    report();
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, [client, id]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const { type, url } = data as { type?: unknown; url?: unknown };
      if (type !== OPEN_MESSAGE || typeof url !== 'string') return;
      const hash = new URL(url, window.location.origin).hash;
      window.location.hash = hash || '#/';
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    void syncPush();
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);
}

/** Mounted once in the app: presence, notification clicks and the start-up sync. */
export function PushPresence(): null {
  usePushPresence(useBoardClient());
  return null;
}

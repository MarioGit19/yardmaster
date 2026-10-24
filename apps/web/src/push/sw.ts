import {
  closeAnswered,
  readPayload,
  routeClick,
  showOptions,
  type WindowLike,
} from './sw-logic.js';

// The board's service worker (`/sw.js`): shows Web Push notifications and routes their clicks.
// It caches nothing; the board is always live. Types are declared here because the app's
// TypeScript lib is the DOM one, not WebWorker.

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushEvent extends ExtendableEvent {
  data: { json(): unknown } | null;
}
interface ShownNotification {
  data: unknown;
  close(): void;
}
interface NotificationEvent extends ExtendableEvent {
  action: string;
  notification: ShownNotification;
}
interface WorkerScope {
  location: Location;
  registration: {
    showNotification(title: string, options: object): Promise<void>;
    getNotifications(filter?: { tag?: string }): Promise<ShownNotification[]>;
  };
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
}

const worker = self as unknown as WorkerScope;

worker.addEventListener('install', () => {
  void worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener('push', (event) => {
  let raw: unknown = null;
  try {
    raw = event.data?.json() ?? null;
  } catch {
    raw = null;
  }
  const payload = readPayload(raw);
  if (!payload) return;
  if (payload.type === 'close') {
    event.waitUntil(
      worker.registration
        .getNotifications({ tag: payload.tag })
        .then((shown) => closeAnswered(shown, payload.request)),
    );
    return;
  }
  event.waitUntil(worker.registration.showNotification(payload.title, showOptions(payload)));
});

worker.addEventListener('notificationclick', (event) => {
  const { notification, action } = event;
  notification.close();
  event.waitUntil(
    routeClick(action, notification.data, {
      origin: worker.location.origin,
      fetch: (url, init) => fetch(url, init),
      windows: () => worker.clients.matchAll({ type: 'window', includeUncontrolled: true }),
      openWindow: (url) => worker.clients.openWindow(url),
    }),
  );
});

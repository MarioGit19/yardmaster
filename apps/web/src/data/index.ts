import { SESSION_PROTOCOL_PREFIX } from '@yardmaster/protocol';
import {
  isSignedOut,
  markSignedOut,
  onSessionChange,
  sessionProtocols,
  startSessionSync,
} from '../auth/session.js';
import { BoardClient } from './client.js';
import { createBoardStore } from './store.js';

export * from './activity.js';
export * from './client.js';
export * from './react.js';
export * from './selectors.js';
export * from './store.js';
export * from './useActivity.js';

/** The session secret a socket's subprotocols carried, or null. */
function secretOf(protocols: readonly string[]): string | null {
  const [, entry] = protocols;
  return entry === undefined ? null : entry.slice(SESSION_PROTOCOL_PREFIX.length);
}

type PageLocation = Pick<Location, 'protocol' | 'host'> & Partial<Pick<Location, 'search'>>;

/**
 * `/ws/ui` on the page's own origin (the Vite dev server proxies it). `?worst=1` on the page asks
 * a demo server for its worst-case board; other servers ignore it.
 */
export function boardSocketUrl(location: PageLocation): string {
  const worst = new URLSearchParams(location.search ?? '').get('worst') === '1';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui${worst ? '?worst=1' : ''}`;
}

/** The app's store and client; `start` wires reconnect-on-online. */
export function createBoard(location: PageLocation = window.location) {
  const store = createBoardStore();
  const client = new BoardClient({
    url: boardSocketUrl(location),
    store,
    auth: {
      protocols: () => sessionProtocols(),
      refused: (protocols) => markSignedOut(secretOf(protocols)),
    },
  });
  return {
    store,
    client,
    start() {
      const stopSync = startSessionSync();
      client.start();
      const online = () => client.reconnectNow();
      window.addEventListener('online', online);
      // Signed in again (here after a token rotation, or in another tab): reconnect.
      const offSession = onSessionChange(() => {
        if (!isSignedOut()) client.resume();
      });
      return () => {
        offSession();
        stopSync();
        window.removeEventListener('online', online);
        client.stop();
      };
    },
  };
}

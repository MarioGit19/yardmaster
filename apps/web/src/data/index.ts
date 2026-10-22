import { BoardClient } from './client.js';
import { createBoardStore } from './store.js';

export * from './activity.js';
export * from './client.js';
export * from './react.js';
export * from './selectors.js';
export * from './store.js';
export * from './useActivity.js';

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
  const client = new BoardClient({ url: boardSocketUrl(location), store });
  return {
    store,
    client,
    start() {
      client.start();
      const online = () => client.reconnectNow();
      window.addEventListener('online', online);
      return () => {
        window.removeEventListener('online', online);
        client.stop();
      };
    },
  };
}

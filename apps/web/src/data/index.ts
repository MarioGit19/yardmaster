import { BoardClient } from './client.js';
import { createBoardStore } from './store.js';

export * from './client.js';
export * from './react.js';
export * from './selectors.js';
export * from './store.js';

/** `/ws/ui` on the page's own origin (the Vite dev server proxies it). */
export function boardSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui`;
}

/** The app's store and client; `start` wires reconnect-on-online. */
export function createBoard(location: Pick<Location, 'protocol' | 'host'> = window.location) {
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

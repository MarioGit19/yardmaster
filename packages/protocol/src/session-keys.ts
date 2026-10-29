// Plain constants, no runtime imports: the service worker imports this module on its own
// (`@yardmaster/protocol/session-keys`), so it doesn't bundle zod and the schemas.

/**
 * Browser sign-in (PRD §8 item 3). A browser holds a per-browser session secret in its own
 * origin's storage, never in a cookie (browsers send cookies to every port on a host), and sends
 * it as this header on fetches and as a `Sec-WebSocket-Protocol` entry on `/ws/ui`.
 */
export const SESSION_HEADER = 'x-yardmaster-session';
/** The subprotocol the board's socket speaks; the server picks it. */
export const UI_WS_PROTOCOL = 'yardmaster';
/** The second subprotocol entry carries the session secret after this prefix. */
export const SESSION_PROTOCOL_PREFIX = 'yardmaster.session.';
/** Where the page keeps the secret (`localStorage`). The service worker reads an IndexedDB copy. */
export const SESSION_STORAGE_KEY = 'yardmaster.session';
/** The IndexedDB database and store holding the service worker's copy, under `SESSION_STORAGE_KEY`. */
export const SESSION_DB = { name: 'yardmaster', store: 'auth' } as const;
/** The WebSocket close code for a socket without a valid session (also on revoke and rotation). */
export const WS_UNAUTHORIZED = 4401;

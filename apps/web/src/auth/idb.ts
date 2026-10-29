import { SESSION_DB, SESSION_STORAGE_KEY } from '@yardmaster/protocol/session-keys';

// The service worker can't read localStorage, so the page keeps a copy of the session secret in
// IndexedDB, which both share (same origin). Plain IndexedDB, no wrapper: one key in one store.

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(SESSION_DB.name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SESSION_DB.store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(SESSION_DB.store, mode);
      const request = body(tx.objectStore(SESSION_DB.store));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The session secret the page last stored, or null. Never throws. */
export async function readStoredSession(factory: IDBFactory | undefined): Promise<string | null> {
  if (!factory) return null;
  try {
    const value = await run(factory, 'readonly', (store) => store.get(SESSION_STORAGE_KEY));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Stores (or with null, clears) the service worker's copy. Never throws. */
export async function writeStoredSession(
  factory: IDBFactory | undefined,
  secret: string | null,
): Promise<void> {
  if (!factory) return;
  try {
    await run<unknown>(factory, 'readwrite', (store) =>
      secret === null
        ? (store.delete(SESSION_STORAGE_KEY) as IDBRequest<unknown>)
        : (store.put(secret, SESSION_STORAGE_KEY) as IDBRequest<unknown>),
    );
  } catch {
    // Private browsing can refuse IndexedDB: notification actions then open the board instead.
  }
}

// Yardmaster was called c-board. Browser storage written under the old names moves to the new
// ones before the app runs. Kept for one version.

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/**
 * Moves `cboard.*` (localStorage) and `c-board:*` (sessionStorage) keys to their new names. A
 * value already saved under the new name wins. Self-contained on purpose: the build inlines its
 * source into index.html as a classic script, so it runs before any module reads storage.
 */
export function migrateStorage(scope: { localStorage?: Store; sessionStorage?: Store }): void {
  const move = (name: 'localStorage' | 'sessionStorage', from: string, to: string) => {
    try {
      const store = scope[name];
      if (!store) return;
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key?.startsWith(from)) keys.push(key);
      }
      for (const key of keys) {
        const value = store.getItem(key);
        const next = to + key.slice(from.length);
        if (value !== null && store.getItem(next) === null) store.setItem(next, value);
        store.removeItem(key);
      }
    } catch {
      // Storage can be blocked or full; the old values are then just not carried over.
    }
  };
  move('localStorage', 'cboard.', 'yardmaster.');
  move('sessionStorage', 'c-board:', 'yardmaster:');
}

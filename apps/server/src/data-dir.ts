import { chmodSync, closeSync, openSync, statSync } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';

/** The board's database, in the data dir. */
export const DB_FILE = 'board.db';

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/**
 * Makes the data dir private (0700) if group or others can reach it, e.g. an old `~/.c-board`
 * moved into place with its 0755. A link is followed, so its target is the one tightened.
 * Returns whether it changed anything; a missing dir, or one that isn't ours, is left alone.
 */
export async function secureDataDir(home: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(home);
  } catch {
    return false;
  }
  if (!info.isDirectory() || (info.mode & 0o077) === 0) return false;
  try {
    await chmod(home, PRIVATE_DIR);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates `path` as 0600 before SQLite opens it, so it is never readable by others, not even
 * for a moment, and tightens one left looser by an older version. SQLite gives its `-wal` and
 * `-shm` files the database's mode; ones already there are tightened too.
 */
export function prepareDbFile(path: string): void {
  closeSync(openSync(path, 'a', PRIVATE_FILE));
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, PRIVATE_FILE);
    } catch {
      // `-wal` and `-shm` exist only while a database is open or after a crash.
    }
  }
}

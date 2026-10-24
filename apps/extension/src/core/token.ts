import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Where to look for the token, in order: `YARDMASTER_HOME`, the old `CBOARD_HOME`, or
 * `~/.yardmaster` and then the old `~/.c-board`, which a server from before the rename to
 * Yardmaster still uses until it is updated.
 */
export function tokenDirs(env: Record<string, string | undefined>, homedir: string): string[] {
  const home = env.YARDMASTER_HOME?.trim() || env.CBOARD_HOME?.trim();
  return home ? [home] : [join(homedir, '.yardmaster'), join(homedir, '.c-board')];
}

/** The install token from the first `<dir>/token` that has one, or null. */
export async function readToken(dirs: string | readonly string[]): Promise<string | null> {
  for (const dir of typeof dirs === 'string' ? [dirs] : dirs) {
    try {
      const token = (await readFile(join(dir, 'token'), 'utf8')).trim();
      if (TOKEN_PATTERN.test(token)) return token;
    } catch {
      // Missing or unreadable: try the next one.
    }
  }
  return null;
}

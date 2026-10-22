import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The c-board data dir: `CBOARD_HOME`, or `~/.c-board`. */
export function cboardHome(env: Record<string, string | undefined>, homedir: string): string {
  const home = env.CBOARD_HOME?.trim();
  return home ? home : join(homedir, '.c-board');
}

/** The install token from `<home>/token`, or null when it's missing or malformed. */
export async function readToken(home: string): Promise<string | null> {
  try {
    const token = (await readFile(join(home, 'token'), 'utf8')).trim();
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

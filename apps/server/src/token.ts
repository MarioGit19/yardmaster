import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TOKEN_FILE = 'token';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function tokenPath(home: string): string {
  return join(home, TOKEN_FILE);
}

/** 32 random bytes, base64url (43 chars, no padding). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isValidToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Constant-time comparison that doesn't leak the length of either side. */
export function tokensEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return undefined;
    throw err;
  }
}

export async function writeToken(home: string, token: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = tokenPath(home);
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  // writeFile's mode only applies on create, so tighten an existing file too.
  await chmod(path, 0o600);
}

/**
 * Returns the install token from `<home>/token`, creating it (0600) when missing.
 * A file with unusable content is replaced; one with loose permissions is tightened.
 */
export async function ensureToken(home: string): Promise<string> {
  const path = tokenPath(home);
  const existing = await readExisting(path);
  if (existing !== undefined && isValidToken(existing)) {
    if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600);
    return existing;
  }

  await mkdir(home, { recursive: true, mode: 0o700 });
  const token = generateToken();
  if (existing === undefined) {
    try {
      await writeFile(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
      return token;
    } catch (err) {
      // Another process created it between our read and write; use theirs.
      if (!isErrno(err, 'EEXIST')) throw err;
      const raced = await readExisting(path);
      if (raced !== undefined && isValidToken(raced)) return raced;
    }
  }
  await writeToken(home, token);
  return token;
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** Writes a complete token beside the real file, so it can appear there in one atomic step. */
async function writeTempToken(home: string, token: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temp = join(home, `${TOKEN_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, `${token}\n`, { mode: 0o600, flag: 'wx' });
  return temp;
}

export async function writeToken(home: string, token: string): Promise<void> {
  const temp = await writeTempToken(home, token);
  try {
    await rename(temp, tokenPath(home));
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Returns the install token from `<home>/token`, creating it (0600) when missing.
 * A file with unusable content is replaced; one with loose permissions is tightened.
 * The file only ever appears with its full content, so concurrent starts can't read
 * it half-written, and they all settle on whichever token was linked first.
 */
export async function ensureToken(home: string): Promise<string> {
  const path = tokenPath(home);
  const existing = await readExisting(path);
  if (existing !== undefined && isValidToken(existing)) {
    if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600);
    return existing;
  }

  const token = generateToken();
  if (existing !== undefined) {
    await writeToken(home, token);
    return token;
  }

  const temp = await writeTempToken(home, token);
  try {
    // Unlike rename, link refuses to replace a token another process just created.
    await link(temp, path);
    return token;
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err;
    const raced = await readExisting(path);
    if (raced !== undefined && isValidToken(raced)) return raced;
    await writeToken(home, token);
    return token;
  } finally {
    await rm(temp, { force: true });
  }
}

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureToken, generateToken, isValidToken, tokenPath, tokensEqual } from './token.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cboard-token-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('generateToken', () => {
  it('produces 32 random bytes as base64url', () => {
    const token = generateToken();
    expect(isValidToken(token)).toBe(true);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateToken()).not.toBe(token);
  });
});

describe('ensureToken', () => {
  it('creates the home dir and a 0600 token file when missing', async () => {
    const home = join(root, 'nested', '.c-board');
    const token = await ensureToken(home);
    expect(isValidToken(token)).toBe(true);
    expect((await readFile(tokenPath(home), 'utf8')).trim()).toBe(token);
    expect(await mode(tokenPath(home))).toBe(0o600);
    expect(await mode(home)).toBe(0o700);
  });

  it('reuses an existing token', async () => {
    const first = await ensureToken(root);
    expect(await ensureToken(root)).toBe(first);
  });

  it('tightens loose permissions on an existing token', async () => {
    const token = await ensureToken(root);
    await chmod(tokenPath(root), 0o644);
    expect(await ensureToken(root)).toBe(token);
    expect(await mode(tokenPath(root))).toBe(0o600);
  });

  it('replaces a token file with unusable content', async () => {
    await writeFile(tokenPath(root), 'not a token\n', { mode: 0o644 });
    const token = await ensureToken(root);
    expect(isValidToken(token)).toBe(true);
    expect((await readFile(tokenPath(root), 'utf8')).trim()).toBe(token);
    expect(await mode(tokenPath(root))).toBe(0o600);
  });

  it('returns the same token to concurrent callers', async () => {
    const tokens = await Promise.all([ensureToken(root), ensureToken(root), ensureToken(root)]);
    expect(new Set(tokens).size).toBe(1);
  });
});

describe('tokensEqual', () => {
  it('compares values of any length', () => {
    const token = generateToken();
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual(token, token.slice(1))).toBe(false);
    expect(tokensEqual('', token)).toBe(false);
  });
});

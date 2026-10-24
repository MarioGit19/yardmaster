import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readToken, tokenDirs } from './token.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const token = `${'Ab0_-'.repeat(8)}xyz`;

describe('tokenDirs', () => {
  it('prefers YARDMASTER_HOME, then the old CBOARD_HOME', () => {
    expect(tokenDirs({ YARDMASTER_HOME: '/home/dev/board' }, '/home/dev')).toEqual([
      '/home/dev/board',
    ]);
    expect(
      tokenDirs({ YARDMASTER_HOME: ' ', CBOARD_HOME: '/home/dev/old-board' }, '/home/dev'),
    ).toEqual(['/home/dev/old-board']);
  });

  it('falls back to ~/.yardmaster, then the old ~/.c-board', () => {
    expect(tokenDirs({}, '/home/dev')).toEqual(['/home/dev/.yardmaster', '/home/dev/.c-board']);
  });
});

describe('readToken', () => {
  it('reads a trimmed token, and returns null when missing or malformed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'yardmaster-ext-'));
    expect(await readToken(dir)).toBeNull();

    await writeFile(join(dir, 'token'), `${token}\n`);
    expect(await readToken(dir)).toBe(token);

    await writeFile(join(dir, 'token'), 'short\n');
    expect(await readToken(dir)).toBeNull();
  });

  it('takes the first directory that has a token', async () => {
    dir = await mkdtemp(join(tmpdir(), 'yardmaster-ext-'));
    const fresh = join(dir, '.yardmaster');
    const legacy = join(dir, '.c-board');
    await mkdir(legacy);
    await writeFile(join(legacy, 'token'), token);
    expect(await readToken([fresh, legacy])).toBe(token);

    await mkdir(fresh);
    await writeFile(join(fresh, 'token'), `${'Z'.repeat(43)}\n`);
    expect(await readToken([fresh, legacy])).toBe('Z'.repeat(43));
  });
});

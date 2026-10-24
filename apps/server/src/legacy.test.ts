import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envValue, headerValue, legacyHomeFor, migrateHome } from './legacy.js';

let dir: string;
let home: string;
let legacy: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yardmaster-legacy-'));
  home = join(dir, '.yardmaster');
  legacy = join(dir, '.c-board');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedLegacy(): Promise<void> {
  await mkdir(join(legacy, 'shell'), { recursive: true });
  await writeFile(join(legacy, 'token'), 'synthetic-token\n', { mode: 0o600 });
  await writeFile(join(legacy, 'board.db'), 'synthetic-db');
}

describe('migrateHome', () => {
  it('moves the old data dir and leaves a symlink at the old path', async () => {
    await seedLegacy();
    expect(await migrateHome(home, legacy)).toEqual({ kind: 'moved', from: legacy });
    expect(await readFile(join(home, 'token'), 'utf8')).toBe('synthetic-token\n');
    expect(await readFile(join(home, 'board.db'), 'utf8')).toBe('synthetic-db');
    expect((await lstat(join(home, 'token'))).mode & 0o777).toBe(0o600);
    expect((await lstat(legacy)).isSymbolicLink()).toBe(true);
    expect(await readlink(legacy)).toBe(home);
    // The old path still reads the same files, for an old extension or hook script.
    expect(await readFile(join(legacy, 'token'), 'utf8')).toBe('synthetic-token\n');
  });

  it('does nothing on the next start, with the symlink already present', async () => {
    await seedLegacy();
    await migrateHome(home, legacy);
    expect(await migrateHome(home, legacy)).toEqual({ kind: 'none' });
    expect(await readFile(join(home, 'token'), 'utf8')).toBe('synthetic-token\n');
  });

  it('leaves a dangling symlink to the new dir alone', async () => {
    await symlink(home, legacy, 'dir');
    expect(await migrateHome(home, legacy)).toEqual({ kind: 'none' });
    expect((await lstat(legacy)).isSymbolicLink()).toBe(true);
  });

  it('follows a user-made symlink at the old path', async () => {
    const elsewhere = join(dir, 'data');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'token'), 'synthetic-token\n');
    await symlink(elsewhere, legacy, 'dir');
    expect((await migrateHome(home, legacy)).kind).toBe('moved');
    expect(await readFile(join(home, 'token'), 'utf8')).toBe('synthetic-token\n');
    expect(await readFile(join(legacy, 'token'), 'utf8')).toBe('synthetic-token\n');
  });

  it('never touches an existing new dir', async () => {
    await seedLegacy();
    await mkdir(home);
    await writeFile(join(home, 'token'), 'newer\n');
    expect(await migrateHome(home, legacy)).toEqual({ kind: 'none' });
    expect(await readFile(join(home, 'token'), 'utf8')).toBe('newer\n');
    expect(await readFile(join(legacy, 'token'), 'utf8')).toBe('synthetic-token\n');
  });

  it('does nothing on a fresh install', async () => {
    expect(await migrateHome(home, legacy)).toEqual({ kind: 'none' });
    await expect(lstat(home)).rejects.toThrow();
  });

  it('reports a failure instead of throwing', async () => {
    await seedLegacy();
    // The new dir's parent is a file, so the move can't happen.
    const blocked = join(dir, 'file');
    await writeFile(blocked, '');
    const result = await migrateHome(join(blocked, '.yardmaster'), legacy);
    expect(result.kind).toBe('failed');
    expect(await readFile(join(legacy, 'token'), 'utf8')).toBe('synthetic-token\n');
  });
});

describe('legacyHomeFor', () => {
  it('migrates only the default data dir', () => {
    expect(legacyHomeFor({}, '/home/dev')).toBe('/home/dev/.c-board');
    expect(legacyHomeFor({ YARDMASTER_HOME: '/srv/board' }, '/home/dev')).toBeNull();
    expect(legacyHomeFor({ CBOARD_HOME: '/srv/board' }, '/home/dev')).toBeNull();
  });
});

describe('envValue', () => {
  it('prefers YARDMASTER_*, falls back to CBOARD_* and skips blanks', () => {
    expect(envValue({ YARDMASTER_PORT: '1', CBOARD_PORT: '2' }, 'PORT')).toBe('1');
    expect(envValue({ CBOARD_PORT: '2' }, 'PORT')).toBe('2');
    expect(envValue({ YARDMASTER_PORT: ' ', CBOARD_PORT: '2' }, 'PORT')).toBe('2');
    expect(envValue({}, 'PORT')).toBeUndefined();
  });
});

describe('headerValue', () => {
  it('reads the new header, then the old one', () => {
    const name = 'x-yardmaster-token';
    const old = 'x-cboard-token';
    expect(headerValue({ [name]: 'a', [old]: 'b' }, name, old)).toBe('a');
    expect(headerValue({ [old]: 'b' }, name, old)).toBe('b');
    expect(headerValue({ [old]: ['c', 'd'] }, name, old)).toBe('c');
    expect(headerValue({}, name, old)).toBeUndefined();
  });
});

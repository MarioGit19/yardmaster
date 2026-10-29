import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secureDataDir } from './data-dir.js';

let base = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ym-data-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe('secureDataDir', () => {
  it('tightens a data dir other users can read to 0700', async () => {
    const home = join(base, '.yardmaster');
    await mkdir(home);
    await chmod(home, 0o755);
    expect(await secureDataDir(home)).toBe(true);
    expect(await modeOf(home)).toBe(0o700);
  });

  it('leaves a private one alone', async () => {
    const home = join(base, '.yardmaster');
    await mkdir(home, { mode: 0o700 });
    expect(await secureDataDir(home)).toBe(false);
    expect(await modeOf(home)).toBe(0o700);
  });

  it('tightens the target of a linked data dir, such as a migrated ~/.c-board', async () => {
    const target = join(base, '.c-board');
    await mkdir(target);
    await chmod(target, 0o755);
    const home = join(base, '.yardmaster');
    await symlink(target, home, 'dir');
    expect(await secureDataDir(home)).toBe(true);
    expect(await modeOf(target)).toBe(0o700);
  });

  it('does nothing for a missing dir', async () => {
    expect(await secureDataDir(join(base, 'missing'))).toBe(false);
  });
});

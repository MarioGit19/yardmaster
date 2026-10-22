import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cboardHome, readToken } from './token.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('cboardHome', () => {
  it('prefers CBOARD_HOME and falls back to ~/.c-board', () => {
    expect(cboardHome({ CBOARD_HOME: '/home/dev/board' }, '/home/dev')).toBe('/home/dev/board');
    expect(cboardHome({ CBOARD_HOME: ' ' }, '/home/dev')).toBe('/home/dev/.c-board');
    expect(cboardHome({}, '/home/dev')).toBe('/home/dev/.c-board');
  });
});

describe('readToken', () => {
  it('reads a trimmed token, and returns null when missing or malformed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cboard-ext-'));
    expect(await readToken(dir)).toBeNull();

    const token = `${'Ab0_-'.repeat(8)}xyz`;
    await writeFile(join(dir, 'token'), `${token}\n`);
    expect(await readToken(dir)).toBe(token);

    await writeFile(join(dir, 'token'), 'short\n');
    expect(await readToken(dir)).toBeNull();
  });
});

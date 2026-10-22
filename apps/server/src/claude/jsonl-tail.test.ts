import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlTail } from './jsonl-tail.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c-board-tail-'));
  path = join(dir, 'session.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('JsonlTail', () => {
  it('reads a missing file as empty', async () => {
    const tail = new JsonlTail(path);
    expect(await tail.read()).toEqual({ lines: [], reset: false });
    expect(tail.offset).toBe(0);
  });

  it('returns complete lines only and picks up the rest once the newline arrives', async () => {
    await writeFile(path, '{"a":1}\n{"b":2}\n{"c":');
    const tail = new JsonlTail(path);
    expect((await tail.read()).lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(tail.offset).toBe(16);
    expect((await tail.read()).lines).toEqual([]);

    await appendFile(path, '3}\n{"d":4}\n');
    expect((await tail.read()).lines).toEqual(['{"c":3}', '{"d":4}']);
  });

  it('keeps multi-byte characters intact', async () => {
    await writeFile(path, `${JSON.stringify({ t: 'grüße ✓ 日本' })}\n`);
    const [line] = (await new JsonlTail(path).read()).lines;
    expect(JSON.parse(line as string)).toEqual({ t: 'grüße ✓ 日本' });
  });

  it('reads lines that span read chunks', async () => {
    const long = 'y'.repeat(3 * 1024 * 1024);
    await writeFile(path, `{"s":"${long}"}\n{"n":1}\n`);
    const { lines } = await new JsonlTail(path).read();
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] as string) as { s: string }).s.length).toBe(long.length);
  });

  it('restarts from the beginning when the file shrinks', async () => {
    await writeFile(path, '{"a":1}\n{"b":2}\n');
    const tail = new JsonlTail(path);
    await tail.read();
    await writeFile(path, '{"z":0}\n');
    expect(await tail.read()).toEqual({ lines: ['{"z":0}'], reset: true });
  });

  it('seeks to the end of the last complete line within a size', async () => {
    await writeFile(path, '{"a":1}\n{"b":2}\n{"c":');
    const tail = new JsonlTail(path);
    await tail.seekToLineEnd(21);
    expect(tail.offset).toBe(16);
    await tail.seekToLineEnd(10);
    expect(tail.offset).toBe(8);
    await tail.seekToLineEnd(5);
    expect(tail.offset).toBe(0);
    await tail.seekToLineEnd(21);
    await appendFile(path, '3}\n');
    expect((await tail.read()).lines).toEqual(['{"c":3}']);
  });
});

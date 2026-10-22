import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkBatcher, FLUSH_BYTES, FLUSH_MS } from './chunk-batcher.js';

function make(options: { flushMs?: number; maxBytes?: number } = {}) {
  const batches: { seq: number; chunk: string }[] = [];
  const batcher = new ChunkBatcher({
    ...options,
    emit: (seq, chunk) => batches.push({ seq, chunk }),
  });
  return { batcher, batches };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ChunkBatcher', () => {
  it('flushes 50 ms after the first pending chunk', () => {
    const { batcher, batches } = make();
    batcher.push('a');
    vi.advanceTimersByTime(30);
    batcher.push('b');
    vi.advanceTimersByTime(FLUSH_MS - 31);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([{ seq: 0, chunk: 'ab' }]);

    // The timer starts again with the next chunk, not on a fixed tick.
    vi.advanceTimersByTime(500);
    batcher.push('c');
    vi.advanceTimersByTime(FLUSH_MS);
    expect(batches).toEqual([
      { seq: 0, chunk: 'ab' },
      { seq: 1, chunk: 'c' },
    ]);
  });

  it('flushes as soon as 16 KB are pending', () => {
    const { batcher, batches } = make();
    batcher.push('x'.repeat(FLUSH_BYTES - 1));
    expect(batches).toEqual([]);
    batcher.push('y');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.chunk).toHaveLength(FLUSH_BYTES);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(batches).toHaveLength(1);
  });

  it('splits large input into batches of at most maxBytes, keeping order', () => {
    const { batcher, batches } = make({ maxBytes: 10 });
    batcher.push('0123');
    batcher.push('456789abcdefghijklmnop');
    vi.advanceTimersByTime(FLUSH_MS);
    expect(batches).toEqual([
      { seq: 0, chunk: '0123456789' },
      { seq: 1, chunk: 'abcdefghij' },
      { seq: 2, chunk: 'klmnop' },
    ]);
    expect(batcher.nextSeq).toBe(3);
  });

  it('counts UTF-8 bytes and never splits a code point', () => {
    const { batcher, batches } = make({ maxBytes: 8 });
    // 'é' is 2 bytes, '🚀' is 4 bytes (a surrogate pair).
    batcher.push('ab🚀🚀éé');
    batcher.flush();
    expect(batches.map((b) => b.chunk)).toEqual(['ab🚀', '🚀éé']);
    for (const { chunk } of batches) expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(8);
  });

  it('flushes on demand and stops after close', () => {
    const { batcher, batches } = make();
    batcher.push('');
    batcher.flush();
    expect(batches).toEqual([]);
    batcher.push('tail');
    batcher.close();
    batcher.push('ignored');
    vi.advanceTimersByTime(FLUSH_MS * 2);
    expect(batches).toEqual([{ seq: 0, chunk: 'tail' }]);
  });

  it('keeps seqs increasing across timer and size flushes', () => {
    const { batcher, batches } = make({ maxBytes: 4 });
    batcher.push('ab');
    vi.advanceTimersByTime(FLUSH_MS);
    batcher.push('cdefg');
    batcher.push('h');
    vi.advanceTimersByTime(FLUSH_MS);
    expect(batches.map((b) => b.seq)).toEqual([0, 1, 2]);
    expect(batches.map((b) => b.chunk).join('')).toBe('abcdefgh');
  });
});

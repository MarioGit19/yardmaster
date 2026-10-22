import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  it('assigns consecutive seqs and reads from any seq', () => {
    const ring = new RingBuffer(1024);
    expect(['a', 'b', 'c'].map((c) => ring.append(c))).toEqual([0, 1, 2]);
    expect(ring.read()).toEqual({
      chunks: [
        { seq: 0, chunk: 'a' },
        { seq: 1, chunk: 'b' },
        { seq: 2, chunk: 'c' },
      ],
      truncated: false,
      nextSeq: 3,
    });
    expect(ring.read(2).chunks).toEqual([{ seq: 2, chunk: 'c' }]);
    expect(ring.read(3)).toEqual({ chunks: [], truncated: false, nextSeq: 3 });
    expect(ring.append('')).toBe(-1);
    expect(ring.nextSeq).toBe(3);
  });

  it('drops the oldest chunks past the byte cap and flags truncation', () => {
    const ring = new RingBuffer(10);
    for (let i = 0; i < 6; i++) ring.append(`${i}${i}${i}`);
    // 6 × 3 bytes; only the newest 3 fit in 10 bytes.
    expect(ring.size).toBe(9);
    expect(ring.firstSeq).toBe(3);
    expect(ring.truncated).toBe(true);
    const all = ring.read(0);
    expect(all.truncated).toBe(true);
    expect(all.chunks.map((c) => c.seq)).toEqual([3, 4, 5]);
    expect(ring.read(3).truncated).toBe(false);
  });

  it('keeps seqs continuous across truncation', () => {
    const ring = new RingBuffer(64);
    let expected = 0;
    for (let i = 0; i < 5_000; i++) {
      expect(ring.append(`line ${i}\n`)).toBe(expected++);
      expect(ring.size).toBeLessThanOrEqual(64);
    }
    const { chunks, nextSeq } = ring.read();
    expect(nextSeq).toBe(5_000);
    expect(chunks.at(-1)?.seq).toBe(4_999);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => ring.firstSeq + i));
    expect(chunks.map((c) => c.chunk).join('')).toBe(
      Array.from({ length: chunks.length }, (_, i) => `line ${5_000 - chunks.length + i}\n`).join(
        '',
      ),
    );
  });

  it('cuts an oversized chunk to its tail on a code point boundary', () => {
    const ring = new RingBuffer(8);
    ring.append('old');
    const seq = ring.append('abcdéfgh€'); // 12 bytes
    const { chunks, truncated } = ring.read(seq);
    expect(truncated).toBe(true);
    expect(chunks).toHaveLength(1);
    const kept = chunks[0]?.chunk ?? '';
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(8);
    expect('abcdéfgh€'.endsWith(kept)).toBe(true);
    expect(kept).not.toContain('�');
    expect(ring.size).toBe(Buffer.byteLength(kept));
  });

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    const ring = new RingBuffer(6);
    ring.append('ab');
    ring.append('€€'); // 6 bytes, forces 'ab' out
    expect(ring.size).toBe(6);
    expect(ring.read().chunks).toEqual([{ seq: 1, chunk: '€€' }]);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });
});

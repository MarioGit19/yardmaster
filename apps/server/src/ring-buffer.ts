export interface StreamChunk {
  seq: number;
  chunk: string;
}

export interface ReadResult {
  chunks: StreamChunk[];
  /** True when data the reader asked for was already dropped. */
  truncated: boolean;
  /** Seq the next appended chunk will get. */
  nextSeq: number;
}

interface Entry extends StreamChunk {
  bytes: number;
}

/** Keeps the last `maxBytes` of a UTF-8 string, never splitting a code point. */
function tailBytes(chunk: string, maxBytes: number): string {
  const buf = Buffer.from(chunk, 'utf8');
  let start = buf.length - maxBytes;
  // Skip continuation bytes (10xxxxxx) so the result starts on a code point.
  while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/**
 * Output ring buffer capped by UTF-8 bytes. Every chunk gets the next seq;
 * seqs keep counting when old chunks are dropped, so readers can resume
 * from any seq and learn whether they missed data.
 */
export class RingBuffer {
  readonly maxBytes: number;
  private entries: Entry[] = [];
  private head = 0;
  private bytes = 0;
  private seq = 0;
  private dropped = false;
  /** Highest seq whose chunk was cut to fit; -1 if none. */
  private cutSeq = -1;

  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive integer');
    }
    this.maxBytes = maxBytes;
  }

  /** Bytes currently held. */
  get size(): number {
    return this.bytes;
  }

  get nextSeq(): number {
    return this.seq;
  }

  /** Seq of the oldest retained chunk (equals `nextSeq` when empty). */
  get firstSeq(): number {
    return this.entries[this.head]?.seq ?? this.seq;
  }

  /** Whether any output has been dropped since the buffer was created. */
  get truncated(): boolean {
    return this.dropped;
  }

  /** Appends a chunk and returns its seq. Empty chunks are ignored (returns -1). */
  append(chunk: string): number {
    if (chunk.length === 0) return -1;
    const seq = this.seq++;
    let bytes = Buffer.byteLength(chunk, 'utf8');
    if (bytes > this.maxBytes) {
      chunk = tailBytes(chunk, this.maxBytes);
      bytes = Buffer.byteLength(chunk, 'utf8');
      this.dropped = true;
      this.cutSeq = seq;
    }
    this.entries.push({ seq, chunk, bytes });
    this.bytes += bytes;
    this.evict();
    return seq;
  }

  /** Chunks with `seq >= fromSeq` (all retained chunks by default). */
  read(fromSeq = 0): ReadResult {
    const from = Math.max(0, fromSeq);
    const chunks: StreamChunk[] = [];
    for (let i = this.head; i < this.entries.length; i++) {
      const entry = this.entries[i] as Entry;
      if (entry.seq >= from) chunks.push({ seq: entry.seq, chunk: entry.chunk });
    }
    return { chunks, truncated: from < this.firstSeq || from <= this.cutSeq, nextSeq: this.seq };
  }

  private evict(): void {
    while (this.bytes > this.maxBytes && this.head < this.entries.length - 1) {
      const entry = this.entries[this.head] as Entry;
      this.bytes -= entry.bytes;
      this.head++;
      this.dropped = true;
    }
    if (this.head > 1024 && this.head * 2 > this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }
}

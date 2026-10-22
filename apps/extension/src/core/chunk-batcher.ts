/** PRD §7: `exec.data` is batched every ≤ 50 ms or 16 KB. */
export const FLUSH_MS = 50;
export const FLUSH_BYTES = 16 * 1024;

export interface ChunkBatcherOptions {
  /** Receives each batch with its seq (0, 1, 2, … per batcher). */
  emit: (seq: number, chunk: string) => void;
  flushMs?: number;
  /** Largest batch in UTF-8 bytes; bigger input is split. */
  maxBytes?: number;
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * The longest prefix of `text` that fits in `budget` UTF-8 bytes, never splitting a
 * surrogate pair. Returns at least one code point so callers always make progress.
 */
function fitPrefix(text: string, budget: number): string {
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const code = text.codePointAt(end) as number;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > budget && end > 0) break;
    bytes += size;
    end += code >= 0x10000 ? 2 : 1;
  }
  return text.slice(0, end);
}

/**
 * Collects output chunks and emits them in order as numbered batches: `flushMs` after
 * the first pending chunk, as soon as `maxBytes` is reached, or on `flush()`.
 */
export class ChunkBatcher {
  private readonly emit: (seq: number, chunk: string) => void;
  private readonly flushMs: number;
  private readonly maxBytes: number;
  private pending: string[] = [];
  private pendingBytes = 0;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(options: ChunkBatcherOptions) {
    this.emit = options.emit;
    this.flushMs = options.flushMs ?? FLUSH_MS;
    this.maxBytes = options.maxBytes ?? FLUSH_BYTES;
  }

  /** Seq the next batch will get. */
  get nextSeq(): number {
    return this.seq;
  }

  push(chunk: string): void {
    if (this.closed || chunk.length === 0) return;
    let rest = chunk;
    while (rest.length > 0) {
      const room = this.maxBytes - this.pendingBytes;
      const bytes = utf8Bytes(rest);
      if (bytes <= room) {
        this.pending.push(rest);
        this.pendingBytes += bytes;
        break;
      }
      const head = fitPrefix(rest, room);
      const headBytes = utf8Bytes(head);
      if (headBytes > room && this.pending.length > 0) {
        // Not even one code point fits; send what is pending first.
        this.flush();
        continue;
      }
      this.pending.push(head);
      this.pendingBytes += headBytes;
      rest = rest.slice(head.length);
      this.flush();
    }
    if (this.pendingBytes >= this.maxBytes) this.flush();
    else if (this.pending.length > 0 && this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  /** Emits pending output now. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const chunk = this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;
    this.emit(this.seq++, chunk);
  }

  /** Flushes and stops accepting output. */
  close(): void {
    this.flush();
    this.closed = true;
  }
}

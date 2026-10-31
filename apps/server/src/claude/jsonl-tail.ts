import { open, stat } from 'node:fs/promises';

const CHUNK_BYTES = 1024 * 1024;
/** Longer lines are skipped rather than buffered. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface TailRead {
  /** Complete lines read since the last call (without the newline). */
  lines: string[];
  /** The file shrank or was replaced, so reading restarted at 0. */
  reset: boolean;
}

/**
 * Reads a growing JSONL file incrementally from a byte offset. Only complete lines are
 * returned: a partial last line stays unread until its newline arrives.
 */
export class JsonlTail {
  private position: number;

  constructor(
    readonly path: string,
    offset = 0,
  ) {
    this.position = offset;
  }

  get offset(): number {
    return this.position;
  }

  /**
   * Reads every complete line past the offset, or those within the next `limit` bytes. A missing
   * file reads as empty.
   */
  async read(limit = Number.POSITIVE_INFINITY): Promise<TailRead> {
    const fileEnd = await fileSize(this.path);
    if (fileEnd === null) return { lines: [], reset: false };
    let size = fileEnd;
    let reset = false;
    if (size < this.position) {
      this.position = 0;
      reset = true;
    }
    if (size === this.position) return { lines: [], reset };
    size = Math.min(size, this.position + limit);

    const lines: string[] = [];
    const handle = await open(this.path, 'r');
    try {
      let carry: Buffer[] = [];
      let carryBytes = 0;
      let skipping = false;
      let pos = this.position;
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      while (pos < size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK_BYTES, size - pos), pos);
        if (bytesRead === 0) break;
        let start = 0;
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] !== NEWLINE) continue;
          if (!skipping) {
            carry.push(buf.subarray(start, i));
            lines.push(Buffer.concat(carry).toString('utf8'));
          }
          carry = [];
          carryBytes = 0;
          skipping = false;
          start = i + 1;
          this.position = pos + i + 1;
        }
        if (!skipping && start < bytesRead) {
          carryBytes += bytesRead - start;
          if (carryBytes > MAX_LINE_BYTES) {
            skipping = true;
            carry = [];
          } else {
            carry.push(Buffer.from(buf.subarray(start, bytesRead)));
          }
        }
        pos += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return { lines, reset };
  }

  /**
   * Moves the offset to the end of the last complete line within the first `size` bytes,
   * so lines already read another way (SDK history) aren't read again.
   */
  async seekToLineEnd(size: number): Promise<void> {
    const actual = await fileSize(this.path);
    let end = Math.min(size, actual ?? 0);
    if (end === 0) {
      this.position = 0;
      return;
    }
    const handle = await open(this.path, 'r');
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      while (end > 0) {
        const start = Math.max(0, end - buf.length);
        const { bytesRead } = await handle.read(buf, 0, end - start, start);
        const at = buf.subarray(0, bytesRead).lastIndexOf(NEWLINE);
        if (at !== -1) {
          this.position = start + at + 1;
          return;
        }
        end = start;
      }
      this.position = 0;
    } finally {
      await handle.close();
    }
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

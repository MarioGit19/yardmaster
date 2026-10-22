import { createOscStripper, type OscStripper } from './osc.js';
import { type ReadResult, RingBuffer } from './ring-buffer.js';

/** PRD §9: 2 MB per execution, 8 MB per terminal. */
export const EXEC_BUFFER_BYTES = 2 * 1024 * 1024;
export const TERMINAL_BUFFER_BYTES = 8 * 1024 * 1024;

export type OutputStreamId = `exec:${string}` | `term:${string}`;

export const execStreamId = (execId: string): OutputStreamId => `exec:${execId}`;
export const terminalStreamId = (terminalId: string): OutputStreamId => `term:${terminalId}`;

export type StreamDataListener = (streamId: OutputStreamId, seq: number, chunk: string) => void;

export interface OutputBuffersOptions {
  execBytes?: number;
  terminalBytes?: number;
}

export interface AppendResult {
  /** Output after OSC 633 stripping (may be empty). */
  chunk: string;
  /** UTF-8 bytes of `chunk`. */
  bytes: number;
  /** Whether the execution's buffer has dropped output. */
  truncated: boolean;
}

/**
 * Per-execution and per-terminal output rings. Execution output is also
 * appended to its terminal's ring, so a terminal view replays every run.
 */
export class OutputBuffers {
  private readonly execBytes: number;
  private readonly terminalBytes: number;
  private readonly rings = new Map<OutputStreamId, RingBuffer>();
  private readonly strippers = new Map<string, OscStripper>();
  private readonly listeners = new Set<StreamDataListener>();

  constructor(options: OutputBuffersOptions = {}) {
    this.execBytes = options.execBytes ?? EXEC_BUFFER_BYTES;
    this.terminalBytes = options.terminalBytes ?? TERMINAL_BUFFER_BYTES;
  }

  /** Strips OSC 633 from `raw` and appends it to the execution and terminal rings. */
  append(execId: string, terminalId: string, raw: string): AppendResult {
    let stripper = this.strippers.get(execId);
    if (!stripper) {
      stripper = createOscStripper();
      this.strippers.set(execId, stripper);
    }
    return this.write(execId, terminalId, stripper.push(raw));
  }

  /** Flushes held-back text for an execution that has ended. */
  end(execId: string, terminalId: string): AppendResult {
    const stripper = this.strippers.get(execId);
    this.strippers.delete(execId);
    return this.write(execId, terminalId, stripper?.flush() ?? '');
  }

  read(streamId: OutputStreamId, fromSeq?: number): ReadResult | undefined {
    return this.rings.get(streamId)?.read(fromSeq);
  }

  /** Seq the stream's next chunk will get (0 for a stream with no output yet). */
  nextSeq(streamId: OutputStreamId): number {
    return this.rings.get(streamId)?.nextSeq ?? 0;
  }

  has(streamId: OutputStreamId): boolean {
    return this.rings.has(streamId);
  }

  deleteExec(execId: string): void {
    this.rings.delete(execStreamId(execId));
    this.strippers.delete(execId);
  }

  deleteTerminal(terminalId: string): void {
    this.rings.delete(terminalStreamId(terminalId));
  }

  /** Subscribes to every appended chunk; returns an unsubscribe function. */
  onData(listener: StreamDataListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private write(execId: string, terminalId: string, chunk: string): AppendResult {
    const execRing = this.ring(execStreamId(execId), this.execBytes);
    if (chunk.length > 0) {
      this.emit(execStreamId(execId), execRing.append(chunk), chunk);
      const termRing = this.ring(terminalStreamId(terminalId), this.terminalBytes);
      this.emit(terminalStreamId(terminalId), termRing.append(chunk), chunk);
    }
    return { chunk, bytes: Buffer.byteLength(chunk, 'utf8'), truncated: execRing.truncated };
  }

  private ring(streamId: OutputStreamId, maxBytes: number): RingBuffer {
    let ring = this.rings.get(streamId);
    if (!ring) {
      ring = new RingBuffer(maxBytes);
      this.rings.set(streamId, ring);
    }
    return ring;
  }

  private emit(streamId: OutputStreamId, seq: number, chunk: string): void {
    for (const listener of this.listeners) listener(streamId, seq, chunk);
  }
}

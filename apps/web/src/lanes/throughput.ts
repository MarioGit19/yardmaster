import type { BoardState } from '@yardmaster/protocol';

// Per-terminal activity for the lane graphs (DESIGN.md §4.3): one timer for the whole board
// samples each watched terminal's byte counter once per `SAMPLE_MS` into a 60-slot ring, and its
// CPU every `CPU_SAMPLE_EVERY` ticks into another, so the two windows are 1 and 5 minutes.

export const SAMPLES = 60;
export const SAMPLE_MS = 1_000;
export const CPU_SAMPLE_EVERY = 5;

/** A fixed-size ring of bytes-per-sample values, oldest first when read. */
export class SampleRing {
  private readonly values = new Float64Array(SAMPLES);
  private head = 0;
  /** Samples pushed so far; it also tells a watcher whether anything new arrived. */
  count = 0;

  push(value: number): void {
    this.values[this.head] = Math.max(0, value);
    this.head = (this.head + 1) % SAMPLES;
    this.count++;
  }

  /** How many of the slots hold a real sample. */
  get filled(): number {
    return Math.min(this.count, SAMPLES);
  }

  /** `i` = 0 is the oldest sample, `SAMPLES - 1` the newest. */
  at(i: number): number {
    return this.values[(this.head + i) % SAMPLES] ?? 0;
  }

  /** Adds to a slot without advancing, `age` = 0 being the newest. */
  add(age: number, value: number): void {
    if (age < 0 || age >= SAMPLES) return;
    const index = (this.head - 1 - age + SAMPLES * 2) % SAMPLES;
    this.values[index] = (this.values[index] ?? 0) + Math.max(0, value);
  }

  max(): number {
    let max = 0;
    for (const v of this.values) if (v > max) max = v;
    return max;
  }

  /** Whether any of the newest `count` samples saw output. */
  recent(count: number): boolean {
    for (let age = 0; age < count; age++) if (this.at(SAMPLES - 1 - age) > 0) return true;
    return false;
  }
}

/** Total output bytes of every terminal, from its executions. */
export function bytesByTerminal(board: BoardState): Map<string, number> {
  const totals = new Map<string, number>();
  for (const execution of Object.values(board.executions)) {
    totals.set(
      execution.terminalId,
      (totals.get(execution.terminalId) ?? 0) + execution.outputBytes,
    );
  }
  return totals;
}

/**
 * A plausible recent history for a terminal seen for the first time: each execution's bytes
 * spread evenly over its run, clipped to the ring's window. Without it, every sparkline would
 * start flat after a page load.
 */
export function backfill(board: BoardState, terminalId: string, now: number): SampleRing {
  const ring = new SampleRing();
  for (let i = 0; i < SAMPLES; i++) ring.push(0);
  const windowStart = now - SAMPLES * SAMPLE_MS;
  for (const execution of Object.values(board.executions)) {
    if (execution.terminalId !== terminalId || execution.outputBytes === 0) continue;
    const end = Math.min(now, execution.endedAt ?? now);
    const start = Math.min(execution.startedAt, end);
    if (end <= windowStart) continue;
    const span = Math.max(SAMPLE_MS, end - start);
    const rate = execution.outputBytes / span;
    for (let t = Math.max(start, windowStart); t < end; t += SAMPLE_MS) {
      const slice = Math.min(SAMPLE_MS, end - t);
      ring.add(Math.floor((now - t - 1) / SAMPLE_MS), rate * slice);
    }
  }
  return ring;
}

/** `ring` holds output bytes per second, `cpu` the terminal's CPU percent. */
export type ThroughputListener = (ring: SampleRing, cpu: SampleRing) => void;

export interface ThroughputSource {
  getBoard(): BoardState;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface Watched {
  ring: SampleRing;
  cpu: SampleRing;
  last: number;
  listeners: Set<ThroughputListener>;
}

/** Samples watched terminals while anyone watches; the timer stops with the last watcher. */
export class ThroughputSampler {
  private readonly watched = new Map<string, Watched>();
  private timer: unknown = null;
  private ticks = 0;

  constructor(private readonly source: ThroughputSource) {}

  /** Calls `listener` now and after every sample. Returns the unwatch. */
  watch(terminalId: string, listener: ThroughputListener): () => void {
    let entry = this.watched.get(terminalId);
    if (!entry) {
      const board = this.source.getBoard();
      const cpu = new SampleRing();
      cpu.push(board.terminals[terminalId]?.stats?.cpu ?? 0);
      entry = {
        ring: backfill(board, terminalId, this.source.now()),
        cpu,
        last: bytesByTerminal(board).get(terminalId) ?? 0,
        listeners: new Set(),
      };
      this.watched.set(terminalId, entry);
    }
    entry.listeners.add(listener);
    this.timer ??= this.source.setInterval(() => this.sample(), SAMPLE_MS);
    listener(entry.ring, entry.cpu);
    return () => {
      const current = this.watched.get(terminalId);
      current?.listeners.delete(listener);
      if (current && current.listeners.size === 0) this.watched.delete(terminalId);
      if (this.watched.size === 0 && this.timer !== null) {
        this.source.clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  /** Takes one sample of every watched terminal. Called by the timer. */
  sample(): void {
    const board = this.source.getBoard();
    const totals = bytesByTerminal(board);
    this.ticks++;
    const cpuDue = this.ticks % CPU_SAMPLE_EVERY === 0;
    for (const [terminalId, entry] of this.watched) {
      const bytes = totals.get(terminalId) ?? 0;
      // A drop (executions pruned, a fresh snapshot) counts as no output.
      entry.ring.push(Math.max(0, bytes - entry.last));
      entry.last = bytes;
      if (cpuDue) entry.cpu.push(board.terminals[terminalId]?.stats?.cpu ?? 0);
      for (const listener of [...entry.listeners]) {
        try {
          listener(entry.ring, entry.cpu);
        } catch (error) {
          console.error('[yardmaster] throughput listener failed', error);
        }
      }
    }
  }

  get size(): number {
    return this.watched.size;
  }
}

import { randomUUID } from 'node:crypto';
import type { CommandConfidence } from '@yardmaster/protocol';
import { AltScreenDetector } from './alt-screen.js';
import { ChunkBatcher, type ChunkBatcherOptions } from './chunk-batcher.js';
import { localPath, type UriLike } from './terminal-tracker.js';

const MAX_COMMAND_LINE = 100_000;
/** How long to wait for the output stream to drain after the end event. */
export const END_GRACE_MS = 1_000;
/** Recent executions remembered for `cmd.rerun`. */
export const MAX_REMEMBERED = 500;

/** The parts of `vscode.TerminalShellExecution` the streamer reads. */
export interface ExecutionLike {
  /** `confidence` is `TerminalShellExecutionCommandLineConfidence`: 0 low, 1 medium, 2 high. */
  readonly commandLine: { readonly value: string; readonly confidence: number };
  readonly cwd: UriLike | undefined;
  read(): AsyncIterable<string>;
}

export interface ExecStartPayload {
  execId: string;
  terminalId: string;
  commandLine: string;
  confidence: CommandConfidence;
  cwd: string | null;
}

export interface ExecSink {
  start(payload: ExecStartPayload): void;
  data(execId: string, seq: number, chunk: string): void;
  interactive(execId: string): void;
  end(execId: string, exitCode: number | null): void;
}

export interface RememberedExecution {
  terminalId: string;
  commandLine: string;
}

export interface ExecStreamerOptions {
  sink: ExecSink;
  newId?: () => string;
  endGraceMs?: number;
  batch?: Pick<ChunkBatcherOptions, 'flushMs' | 'maxBytes'>;
  onError?: (message: string) => void;
}

interface Running {
  execId: string;
  terminalId: string;
  batcher: ChunkBatcher;
  altScreen: AltScreenDetector;
  readDone: boolean;
  /** Set once the end event arrived. */
  exitCode: number | null | undefined;
  endTimer: ReturnType<typeof setTimeout> | undefined;
}

const CONFIDENCE: readonly CommandConfidence[] = ['low', 'medium', 'high'];

/**
 * Streams shell-integration executions: `exec.start`, batched and numbered `exec.data`,
 * `exec.interactive` on the first alt-screen switch, then `exec.end` once the output has
 * drained (or after a grace period, if the stream never finishes).
 */
export class ExecStreamer<E extends ExecutionLike> {
  private readonly sink: ExecSink;
  private readonly newId: () => string;
  private readonly endGraceMs: number;
  private readonly batch: ExecStreamerOptions['batch'];
  private readonly onError: (message: string) => void;
  private readonly running = new Map<E, Running>();
  private readonly remembered = new Map<string, RememberedExecution>();

  constructor(options: ExecStreamerOptions) {
    this.sink = options.sink;
    this.newId = options.newId ?? randomUUID;
    this.endGraceMs = options.endGraceMs ?? END_GRACE_MS;
    this.batch = options.batch;
    this.onError = options.onError ?? (() => {});
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** A recent execution started in this activation, by its id. */
  lookup(execId: string): RememberedExecution | undefined {
    return this.remembered.get(execId);
  }

  /** Call from the start event handler: output is only complete if `read()` starts right away. */
  started(execution: E, terminalId: string): void {
    if (this.running.has(execution)) return;
    let stream: AsyncIterable<string>;
    try {
      stream = execution.read();
    } catch (error) {
      this.onError(`could not read an execution: ${String(error)}`);
      return;
    }
    const execId = this.newId();
    const state: Running = {
      execId,
      terminalId,
      batcher: new ChunkBatcher({
        ...this.batch,
        emit: (seq, chunk) => this.sink.data(execId, seq, chunk),
      }),
      altScreen: new AltScreenDetector(),
      readDone: false,
      exitCode: undefined,
      endTimer: undefined,
    };
    this.running.set(execution, state);
    const confidence = CONFIDENCE[execution.commandLine.confidence] ?? 'low';
    const commandLine = execution.commandLine.value.slice(0, MAX_COMMAND_LINE);
    this.remember(execId, { terminalId, commandLine });
    this.sink.start({
      execId,
      terminalId,
      commandLine,
      confidence,
      cwd: localPath(execution.cwd),
    });
    void this.pump(execution, state, stream);
  }

  ended(execution: E, exitCode: number | undefined): void {
    const state = this.running.get(execution);
    if (!state || state.exitCode !== undefined) return;
    state.exitCode = exitCode ?? null;
    if (state.readDone) this.finish(execution, state);
    else state.endTimer = setTimeout(() => this.finish(execution, state), this.endGraceMs);
  }

  /** The terminal is gone: its executions end now, with an unknown exit code. */
  terminalClosed(terminalId: string): void {
    for (const [execution, state] of this.running) {
      if (state.terminalId !== terminalId) continue;
      state.exitCode ??= null;
      this.finish(execution, state);
    }
  }

  /** Flushes and ends everything still running. */
  dispose(): void {
    for (const [execution, state] of this.running) {
      state.exitCode ??= null;
      this.finish(execution, state);
    }
  }

  private remember(execId: string, execution: RememberedExecution): void {
    this.remembered.set(execId, execution);
    if (this.remembered.size <= MAX_REMEMBERED) return;
    const oldest = this.remembered.keys().next().value;
    if (oldest !== undefined) this.remembered.delete(oldest);
  }

  private async pump(execution: E, state: Running, stream: AsyncIterable<string>): Promise<void> {
    try {
      for await (const chunk of stream) {
        if (this.running.get(execution) !== state) return;
        if (state.altScreen.push(chunk)) {
          // Output before the switch goes out first, so the marker lands in order.
          state.batcher.flush();
          this.sink.interactive(state.execId);
        }
        state.batcher.push(chunk);
      }
    } catch (error) {
      this.onError(`execution output failed: ${String(error)}`);
    }
    state.readDone = true;
    if (state.exitCode !== undefined && this.running.get(execution) === state) {
      this.finish(execution, state);
    }
  }

  private finish(execution: E, state: Running): void {
    if (this.running.get(execution) !== state) return;
    this.running.delete(execution);
    clearTimeout(state.endTimer);
    state.batcher.close();
    this.sink.end(state.execId, state.exitCode ?? null);
  }
}

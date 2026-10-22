import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLUSH_MS } from './chunk-batcher.js';
import {
  END_GRACE_MS,
  type ExecSink,
  ExecStreamer,
  type ExecutionLike,
  MAX_REMEMBERED,
} from './exec-streamer.js';

/** A fake execution whose output is pushed by the test. */
class FakeExecution implements ExecutionLike {
  readonly commandLine: { value: string; confidence: number };
  readonly cwd = { scheme: 'file', fsPath: '/home/dev/acme-shop' };
  reads = 0;
  private readonly queue: string[] = [];
  private wake: (() => void) | undefined;
  private done = false;

  constructor(value = 'pnpm test', confidence = 2) {
    this.commandLine = { value, confidence };
  }

  write(chunk: string): void {
    this.queue.push(chunk);
    this.wake?.();
  }

  finish(): void {
    this.done = true;
    this.wake?.();
  }

  read(): AsyncIterable<string> {
    this.reads++;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = self.queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (self.done) return;
          await new Promise<void>((resolve) => {
            self.wake = resolve;
          });
        }
      },
    };
  }
}

function make() {
  const events: unknown[] = [];
  const sink: ExecSink = {
    start: (payload) => events.push(['start', payload]),
    data: (execId, seq, chunk) => events.push(['data', execId, seq, chunk]),
    interactive: (execId) => events.push(['interactive', execId]),
    end: (execId, exitCode) => events.push(['end', execId, exitCode]),
  };
  let n = 0;
  const streamer = new ExecStreamer<FakeExecution>({ sink, newId: () => `exec-${++n}` });
  return { streamer, events };
}

/** Lets the async read loop run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ExecStreamer', () => {
  it('sends start, reads right away, batches output and ends after the stream drains', async () => {
    const { streamer, events } = make();
    const execution = new FakeExecution();
    streamer.started(execution, 'term-1');
    expect(execution.reads).toBe(1);
    expect(events).toEqual([
      [
        'start',
        {
          execId: 'exec-1',
          terminalId: 'term-1',
          commandLine: 'pnpm test',
          confidence: 'high',
          cwd: '/home/dev/acme-shop',
        },
      ],
    ]);

    execution.write('one\r\n');
    execution.write('two\r\n');
    await settle();
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(events[1]).toEqual(['data', 'exec-1', 0, 'one\r\ntwo\r\n']);

    // The end event can arrive before the last output; exec.end waits for it.
    execution.write('three\r\n');
    streamer.ended(execution, 1);
    execution.finish();
    await settle();
    expect(events.slice(2)).toEqual([
      ['data', 'exec-1', 1, 'three\r\n'],
      ['end', 'exec-1', 1],
    ]);
    expect(streamer.runningCount).toBe(0);
  });

  it('ends after the grace period if the stream never finishes', async () => {
    const { streamer, events } = make();
    const execution = new FakeExecution('ls', 0);
    streamer.started(execution, 'term-1');
    execution.write('a');
    streamer.ended(execution, undefined);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS);
    expect(events.slice(1)).toEqual([
      ['data', 'exec-1', 0, 'a'],
      ['end', 'exec-1', null],
    ]);
    execution.write('late');
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(events).toHaveLength(3);
    expect((events[0] as [string, { confidence: string }])[1].confidence).toBe('low');
  });

  it('marks the execution interactive on the alt-screen switch, after earlier output', async () => {
    const { streamer, events } = make();
    const execution = new FakeExecution('htop', 1);
    streamer.started(execution, 'term-1');
    execution.write('starting\r\n');
    execution.write('\x1b[?1049h\x1b[H');
    await settle();
    expect(events.slice(1)).toEqual([
      ['data', 'exec-1', 0, 'starting\r\n'],
      ['interactive', 'exec-1'],
    ]);
    execution.write('\x1b[?1049h');
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(events.filter((e) => (e as string[])[0] === 'interactive')).toHaveLength(1);
  });

  it('ends executions of a closed terminal and everything on dispose', async () => {
    const { streamer, events } = make();
    const a = new FakeExecution();
    const b = new FakeExecution();
    streamer.started(a, 'term-1');
    streamer.started(a, 'term-1');
    streamer.started(b, 'term-2');
    streamer.terminalClosed('term-1');
    expect(events.at(-1)).toEqual(['end', 'exec-1', null]);
    streamer.dispose();
    expect(events.at(-1)).toEqual(['end', 'exec-2', null]);
    expect(events.filter((e) => (e as string[])[0] === 'start')).toHaveLength(2);
  });

  it('skips executions whose output cannot be read', () => {
    const errors: string[] = [];
    const events: unknown[] = [];
    const streamer = new ExecStreamer<ExecutionLike>({
      sink: { start: () => events.push('start'), data() {}, interactive() {}, end() {} },
      onError: (message) => errors.push(message),
    });
    streamer.started(
      {
        commandLine: { value: 'x', confidence: 2 },
        cwd: undefined,
        read: () => {
          throw new Error('disposed');
        },
      },
      'term-1',
    );
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('remembers recent executions for reruns, dropping the oldest', async () => {
    const { streamer } = make();
    streamer.started(new FakeExecution('pnpm test'), 'term-1');
    expect(streamer.lookup('exec-1')).toEqual({ terminalId: 'term-1', commandLine: 'pnpm test' });
    for (let i = 0; i < MAX_REMEMBERED; i++)
      streamer.started(new FakeExecution(`echo ${i}`), 'term-2');
    expect(streamer.lookup('exec-1')).toBeUndefined();
    expect(streamer.lookup(`exec-${MAX_REMEMBERED + 1}`)).toEqual({
      terminalId: 'term-2',
      commandLine: `echo ${MAX_REMEMBERED - 1}`,
    });
    expect(streamer.lookup('missing')).toBeUndefined();
    streamer.dispose();
  });
});

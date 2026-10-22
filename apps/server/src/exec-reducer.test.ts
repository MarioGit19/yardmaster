import { describe, expect, it } from 'vitest';
import { applyExecEvent, type ExecEvent } from './exec-reducer.js';
import { BoardStore, commandHeader } from './store.js';

const T0 = 1_700_000_000_000;

function setup() {
  const store = new BoardStore({ autoFlush: false, now: () => T0 });
  store.upsertTerminal({ id: 'term-1', windowId: 'win-1', name: 'zsh' });
  store.upsertTerminal({ id: 'term-2', windowId: 'win-2', name: 'bash' });
  return store;
}

const start = (execId: string, terminalId = 'term-1'): ExecEvent => ({
  type: 'start',
  execId,
  terminalId,
  commandLine: 'pnpm build',
  confidence: 'medium',
  cwd: '/home/dev/acme-shop',
});
const data = (execId: string, seq: number, chunk: string): ExecEvent => ({
  type: 'data',
  execId,
  seq,
  chunk,
});

describe('applyExecEvent', () => {
  it('starts, streams and ends an execution', () => {
    const store = setup();
    expect(applyExecEvent(store, 'win-1', start('e1'), T0 + 1).applied).toBe(true);
    applyExecEvent(store, 'win-1', data('e1', 0, 'building…\n'), T0 + 2);
    const ended = applyExecEvent(
      store,
      'win-1',
      { type: 'end', execId: 'e1', exitCode: 2 },
      T0 + 3,
    );

    expect(ended).toMatchObject({ applied: true, execution: { exitCode: 2, endedAt: T0 + 3 } });
    expect(store.state.executions.e1).toMatchObject({
      startedAt: T0 + 1,
      confidence: 'medium',
      outputBytes: Buffer.byteLength('building…\n'),
    });
    expect(store.output.read('exec:e1')?.chunks).toEqual([{ seq: 0, chunk: 'building…\n' }]);
    expect(store.output.read('term:term-1')?.chunks).toEqual([
      { seq: 0, chunk: `${commandHeader('pnpm build')}\r\n` },
      { seq: 1, chunk: 'building…\n' },
    ]);
  });

  it('strips OSC 633 markers that reach the output', () => {
    const store = setup();
    applyExecEvent(store, 'win-1', start('e1'), T0);
    applyExecEvent(store, 'win-1', data('e1', 0, '\x1b]633;C\x07out\n'), T0);
    expect(store.output.read('exec:e1')?.chunks.map((c) => c.chunk)).toEqual(['out\n']);
  });

  it('rejects unknown terminals, other windows, duplicates and stale events', () => {
    const store = setup();
    expect(applyExecEvent(store, 'win-1', start('e0', 'nope'), T0)).toEqual({
      applied: false,
      reason: 'unknown terminal',
    });
    expect(applyExecEvent(store, 'win-1', start('e2', 'term-2'), T0)).toEqual({
      applied: false,
      reason: 'other window',
    });
    applyExecEvent(store, 'win-1', start('e1'), T0);
    expect(applyExecEvent(store, 'win-1', start('e1'), T0)).toMatchObject({ reason: 'stale' });
    expect(applyExecEvent(store, 'win-2', data('e1', 0, 'x'), T0)).toMatchObject({
      reason: 'other window',
    });
    expect(applyExecEvent(store, 'win-1', data('nope', 0, 'x'), T0)).toMatchObject({
      reason: 'unknown execution',
    });
    applyExecEvent(store, 'win-1', data('e1', 3, 'a'), T0);
    expect(applyExecEvent(store, 'win-1', data('e1', 2, 'b'), T0)).toMatchObject({
      reason: 'stale',
    });
    applyExecEvent(store, 'win-1', { type: 'end', execId: 'e1', exitCode: 0 }, T0);
    expect(applyExecEvent(store, 'win-1', data('e1', 4, 'c'), T0)).toMatchObject({
      reason: 'stale',
    });
    expect(store.output.read('exec:e1')?.chunks.map((c) => c.chunk)).toEqual(['a']);
  });

  it('marks interactive executions once', () => {
    const store = setup();
    applyExecEvent(store, 'win-1', start('e1'), T0);
    store.flush();
    applyExecEvent(store, 'win-1', { type: 'interactive', execId: 'e1' }, T0);
    applyExecEvent(store, 'win-1', { type: 'interactive', execId: 'e1' }, T0);
    expect(store.state.executions.e1?.interactive).toBe(true);
  });

  it('ends an execution that is still running when the next one starts', () => {
    const store = setup();
    applyExecEvent(store, 'win-1', start('e1'), T0);
    applyExecEvent(store, 'win-1', start('e2'), T0 + 5);
    expect(store.state.executions.e1).toMatchObject({ endedAt: T0 + 5, exitCode: null });
    expect(store.state.executions.e2?.endedAt).toBeNull();
    expect(store.state.terminals['term-1']?.executionIds).toEqual(['e1', 'e2']);
  });
});

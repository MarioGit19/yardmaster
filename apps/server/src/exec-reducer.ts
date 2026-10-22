import type { CommandConfidence, Execution } from '@c-board/protocol';
import type { BoardStore } from './store.js';

export type ExecEvent =
  | {
      type: 'start';
      execId: string;
      terminalId: string;
      commandLine: string;
      confidence: CommandConfidence;
      cwd: string | null;
    }
  | { type: 'data'; execId: string; seq: number; chunk: string }
  | { type: 'interactive'; execId: string }
  | { type: 'end'; execId: string; exitCode: number | null };

export type ExecOutcome =
  | { applied: true; execution: Execution }
  | { applied: false; reason: 'unknown terminal' | 'unknown execution' | 'other window' | 'stale' };

/**
 * Applies an editor execution event to the store. Output goes to the execution's
 * `exec:<id>` ring and its terminal's `term:<id>` ring. Events for terminals owned by
 * another window are ignored, as are replays (by seq) and events after the end.
 */
export function applyExecEvent(
  store: BoardStore,
  windowId: string,
  event: ExecEvent,
  now: number,
): ExecOutcome {
  if (event.type === 'start') {
    const terminal = store.state.terminals[event.terminalId];
    if (!terminal) return { applied: false, reason: 'unknown terminal' };
    if (terminal.windowId !== windowId) return { applied: false, reason: 'other window' };
    if (store.state.executions[event.execId]) return { applied: false, reason: 'stale' };
    // A shell runs one command at a time: an execution still open here lost its end event.
    endRunning(store, terminal.executionIds, now);
    const execution = store.startExec({ ...event, startedAt: now });
    return execution
      ? { applied: true, execution }
      : { applied: false, reason: 'unknown terminal' };
  }

  const execution = store.state.executions[event.execId];
  if (!execution) return { applied: false, reason: 'unknown execution' };
  if (store.state.terminals[execution.terminalId]?.windowId !== windowId) {
    return { applied: false, reason: 'other window' };
  }
  if (execution.endedAt !== null) return { applied: false, reason: 'stale' };

  switch (event.type) {
    case 'data':
      if (!store.appendExecOutput(event.execId, event.chunk, event.seq)) {
        return { applied: false, reason: 'stale' };
      }
      break;
    case 'interactive':
      store.markExecInteractive(event.execId);
      break;
    case 'end':
      store.endExec(event.execId, event.exitCode, now);
      break;
  }
  return { applied: true, execution: store.state.executions[event.execId] ?? execution };
}

/** Ends the terminal's executions that are still running (exit code unknown). */
export function endRunning(store: BoardStore, execIds: readonly string[], now: number): void {
  for (const id of execIds) {
    if (store.state.executions[id]?.endedAt === null) store.endExec(id, null, now);
  }
}

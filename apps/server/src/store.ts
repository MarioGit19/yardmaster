import {
  type Approval,
  type ApprovalState,
  type BoardState,
  type ClaudeSession,
  type CommandConfidence,
  createDiffCollector,
  type DiffCollector,
  type EditorWindow,
  type Execution,
  emptyBoardState,
  type PatchOp,
  type PortBinding,
  type ProcessStats,
  type Project,
  type SessionStatus,
  type Terminal,
} from '@c-board/protocol';
import { OutputBuffers, type OutputBuffersOptions } from './output-buffers.js';

/** Oldest executions (and their output) are dropped past this many per terminal. */
export const MAX_EXECUTIONS_PER_TERMINAL = 100;

export type PatchListener = (ops: PatchOp[]) => void;

export interface BoardStoreOptions {
  now?: () => number;
  buffers?: OutputBuffersOptions;
  maxExecutionsPerTerminal?: number;
  /** Emit a patch on the microtask after a mutation (default). Off: call `flush()`. */
  autoFlush?: boolean;
}

export type TerminalInput = Pick<Terminal, 'id' | 'windowId' | 'name'> &
  Partial<Omit<Terminal, 'id' | 'windowId' | 'name' | 'executionIds'>>;

export interface ExecStartInput {
  execId: string;
  terminalId: string;
  commandLine: string;
  confidence: CommandConfidence;
  cwd: string | null;
  startedAt?: number;
}

export type SessionInput = Pick<ClaudeSession, 'id'> & Partial<Omit<ClaudeSession, 'id'>>;

type Collections = keyof BoardState;

/**
 * In-memory board state. Every mutation goes through the typed mutators
 * below (real ingest and the demo simulator alike); changes leave as
 * coalesced patch ops from `flush()`.
 */
export class BoardStore {
  readonly output: OutputBuffers;
  private readonly collector: DiffCollector<BoardState>;
  private readonly listeners = new Set<PatchListener>();
  private readonly now: () => number;
  private readonly maxExecutions: number;
  private readonly autoFlush: boolean;
  private readonly lastSourceSeq = new Map<string, number>();
  private flushScheduled = false;

  constructor(options: BoardStoreOptions = {}) {
    this.collector = createDiffCollector(emptyBoardState());
    this.output = new OutputBuffers(options.buffers);
    this.now = options.now ?? Date.now;
    this.maxExecutions = options.maxExecutionsPerTerminal ?? MAX_EXECUTIONS_PER_TERMINAL;
    this.autoFlush = options.autoFlush ?? true;
  }

  get state(): BoardState {
    return this.collector.state;
  }

  /** Subscribes to patch batches; returns an unsubscribe function. */
  onPatch(listener: PatchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emits and returns the ops accumulated since the last flush. */
  flush(): PatchOp[] {
    const ops = this.collector.flush();
    if (ops.length > 0) for (const listener of this.listeners) listener(ops);
    return ops;
  }

  // Projects

  upsertProject(project: Project): void {
    this.put('projects', project.id, project);
  }

  touchProject(id: string, ts = this.now()): void {
    const project = this.state.projects[id];
    if (project && (project.lastActivityAt ?? 0) < ts) {
      this.merge('projects', id, { lastActivityAt: ts });
    }
  }

  removeProject(id: string): void {
    this.remove('projects', id);
  }

  // Editor windows

  upsertWindow(window: EditorWindow): void {
    this.put('windows', window.id, window);
  }

  touchWindow(id: string, ts = this.now()): void {
    if (this.state.windows[id]) this.merge('windows', id, { lastSeenAt: ts });
  }

  /** Removes the window and every terminal it owns. */
  removeWindow(id: string): void {
    for (const terminal of Object.values(this.state.terminals)) {
      if (terminal.windowId === id) this.removeTerminal(terminal.id);
    }
    this.remove('windows', id);
  }

  // Terminals

  upsertTerminal(input: TerminalInput): Terminal {
    const existing = this.state.terminals[input.id];
    const terminal: Terminal = existing
      ? { ...existing, ...defined(input) }
      : {
          projectId: null,
          shellPid: null,
          cwd: null,
          state: 'open',
          shellIntegration: false,
          active: false,
          exitCode: null,
          stats: null,
          createdAt: this.now(),
          closedAt: null,
          ...defined(input),
          executionIds: [],
        };
    this.put('terminals', terminal.id, terminal);
    return terminal;
  }

  closeTerminal(id: string, exitCode: number | null, ts = this.now()): void {
    if (!this.state.terminals[id]) return;
    this.merge('terminals', id, { state: 'closed', exitCode, active: false, closedAt: ts });
  }

  setTerminalStats(id: string, stats: ProcessStats | null): void {
    if (this.state.terminals[id]) this.set(['terminals', id, 'stats'], stats);
  }

  /** Removes the terminal, its executions and their output. */
  removeTerminal(id: string): void {
    const terminal = this.state.terminals[id];
    if (!terminal) return;
    for (const execId of terminal.executionIds) this.dropExecution(execId);
    this.output.deleteTerminal(id);
    this.remove('terminals', id);
  }

  // Executions

  /** Records a new execution. Returns undefined if the terminal is unknown. */
  startExec(input: ExecStartInput): Execution | undefined {
    const terminal = this.state.terminals[input.terminalId];
    if (!terminal) return undefined;
    const existing = this.state.executions[input.execId];
    if (existing) return existing;

    const execution: Execution = {
      id: input.execId,
      terminalId: input.terminalId,
      commandLine: input.commandLine,
      confidence: input.confidence,
      cwd: input.cwd,
      startedAt: input.startedAt ?? this.now(),
      endedAt: null,
      exitCode: null,
      outputBytes: 0,
      truncated: false,
      interactive: false,
    };
    this.put('executions', execution.id, execution);

    const ids = [...terminal.executionIds, execution.id];
    const excess = ids.length - this.maxExecutions;
    for (const old of ids.splice(0, Math.max(0, excess))) this.dropExecution(old);
    this.set(['terminals', terminal.id, 'executionIds'], ids);
    if (terminal.projectId) this.touchProject(terminal.projectId, execution.startedAt);
    return execution;
  }

  /**
   * Appends raw output (OSC 633 is stripped, ANSI kept). `sourceSeq` is the
   * sender's chunk seq; replays at or below the last seen seq are ignored.
   */
  appendExecOutput(execId: string, chunk: string, sourceSeq?: number): boolean {
    const execution = this.state.executions[execId];
    if (!execution) return false;
    if (sourceSeq !== undefined) {
      const last = this.lastSourceSeq.get(execId);
      if (last !== undefined && sourceSeq <= last) return false;
      this.lastSourceSeq.set(execId, sourceSeq);
    }
    this.recordOutput(execution, this.output.append(execId, execution.terminalId, chunk));
    return true;
  }

  endExec(execId: string, exitCode: number | null, ts = this.now()): void {
    const execution = this.state.executions[execId];
    if (!execution || execution.endedAt !== null) return;
    this.recordOutput(execution, this.output.end(execId, execution.terminalId));
    this.lastSourceSeq.delete(execId);
    this.merge('executions', execId, { endedAt: ts, exitCode });
  }

  markExecInteractive(execId: string): void {
    const execution = this.state.executions[execId];
    if (execution && !execution.interactive) {
      this.set(['executions', execId, 'interactive'], true);
    }
  }

  // Claude sessions

  upsertSession(input: SessionInput): ClaudeSession {
    const existing = this.state.sessions[input.id];
    const ts = this.now();
    const session: ClaudeSession = existing
      ? { ...existing, ...defined(input), updatedAt: input.updatedAt ?? ts }
      : {
          origin: 'terminal',
          projectId: null,
          cwd: null,
          status: { kind: 'unknown', alive: true },
          title: null,
          model: null,
          permissionMode: null,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          contextTokens: null,
          currentTool: null,
          todos: [],
          subagents: [],
          terminalId: null,
          claudePid: null,
          transcriptPath: null,
          lastAssistantText: null,
          startedAt: ts,
          updatedAt: ts,
          endedAt: null,
          ...defined(input),
        };
    this.put('sessions', session.id, session);
    if (session.projectId) this.touchProject(session.projectId, session.updatedAt);
    return session;
  }

  updateSession(id: string, fields: Partial<Omit<ClaudeSession, 'id'>>, ts = this.now()): void {
    if (!this.state.sessions[id]) return;
    this.merge('sessions', id, { ...defined(fields), updatedAt: fields.updatedAt ?? ts });
  }

  setSessionStatus(id: string, status: SessionStatus, ts = this.now()): void {
    const session = this.state.sessions[id];
    if (!session) return;
    const fields: Partial<ClaudeSession> = { status, updatedAt: ts };
    if (status.kind === 'ended' && session.endedAt === null) fields.endedAt = ts;
    if (status.kind !== 'tool' && session.currentTool) fields.currentTool = null;
    this.merge('sessions', id, fields);
    if (session.projectId) this.touchProject(session.projectId, ts);
  }

  removeSession(id: string): void {
    for (const approval of Object.values(this.state.approvals)) {
      if (approval.sessionId === id) this.remove('approvals', approval.id);
    }
    this.remove('sessions', id);
  }

  // Approvals

  upsertApproval(approval: Approval): void {
    this.put('approvals', approval.id, approval);
  }

  resolveApproval(
    id: string,
    state: Exclude<ApprovalState, 'pending'>,
    reason: string | null = null,
    ts = this.now(),
  ): void {
    const approval = this.state.approvals[id];
    if (approval?.state !== 'pending') return;
    this.merge('approvals', id, { state, reason, decidedAt: ts });
  }

  removeApproval(id: string): void {
    this.remove('approvals', id);
  }

  // Ports

  /** Replaces the port table with the latest scan. */
  setPorts(bindings: readonly PortBinding[]): void {
    const current = this.state.ports;
    const next = new Set(bindings.map((binding) => binding.id));
    for (const id of Object.keys(current)) if (!next.has(id)) this.remove('ports', id);
    for (const binding of bindings) {
      const before = current[binding.id];
      // Keep the first sighting so a rescan doesn't look like a new binding.
      const value = before ? { ...binding, firstSeenAt: before.firstSeenAt } : binding;
      if (!before || !shallowEqual(before, value)) this.put('ports', binding.id, value);
    }
  }

  // Internals

  private recordOutput(execution: Execution, result: { bytes: number; truncated: boolean }): void {
    if (result.bytes === 0 && result.truncated === execution.truncated) return;
    const current = this.state.executions[execution.id] ?? execution;
    this.merge('executions', execution.id, {
      outputBytes: current.outputBytes + result.bytes,
      truncated: result.truncated,
    });
  }

  private dropExecution(execId: string): void {
    this.output.deleteExec(execId);
    this.lastSourceSeq.delete(execId);
    this.remove('executions', execId);
  }

  private put<C extends Collections>(
    collection: C,
    id: string,
    value: BoardState[C][string],
  ): void {
    this.set([collection, id], value);
  }

  private merge<C extends Collections>(
    collection: C,
    id: string,
    fields: Partial<BoardState[C][string]>,
  ): void {
    this.collector.merge([collection, id], fields as Record<string, unknown>);
    this.changed();
  }

  private set(path: string[], value: unknown): void {
    this.collector.set(path, value);
    this.changed();
  }

  private remove(collection: Collections, id: string): void {
    if (!Object.hasOwn(this.state[collection], id)) return;
    this.collector.delete([collection, id]);
    this.changed();
  }

  private changed(): void {
    if (!this.autoFlush || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }
}

/** Drops keys whose value is `undefined`, so partial inputs never erase fields. */
function defined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as T;
}

function shallowEqual(a: object, b: object): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((key) => Object.is((a as never)[key], (b as never)[key]));
}

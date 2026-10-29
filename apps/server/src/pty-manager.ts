import { randomBytes, randomUUID } from 'node:crypto';
import {
  type ActivityEvent,
  BOARD_WINDOW_ID,
  isBoardTerminal,
  isSafeCommandLine,
  MAX_BOARD_TERMINALS,
  type Terminal,
  UNSAFE_COMMAND_LINE,
} from '@yardmaster/protocol';
import type { ActionHandler, ActionHandlers, ActionResult } from './actions.js';
import { NOTHING_TO_RERUN, type TerminalActionKind } from './editor-actions.js';
import { ROUTE_ERRORS } from './editor-router.js';
import type { ProcessTree } from './processes.js';
import type { PtyLoad, PtyProcess } from './pty.js';
import {
  type IntegratedShell,
  integrateShell,
  integrationFor,
  writeShellIntegration,
} from './shell-integration.js';
import {
  createMarkerParser,
  MARKER_NONCE_ENV,
  type MarkerParser,
  type ShellMarker,
} from './shell-markers.js';
import type { BoardStore } from './store.js';

export const PTY_ERRORS = {
  /** node-pty isn't installed or didn't load. */
  unavailable: 'pty_unavailable',
  tooMany: 'too_many_terminals',
  spawnFailed: 'pty_spawn_failed',
  /** A command is running: a re-run would type into it. */
  busy: 'terminal_busy',
} as const;

/** Output is batched for this long (or 16 KB), like the extension's `exec.data`. */
export const PTY_FLUSH_MS = 8;
const FLUSH_BYTES = 16 * 1024;
/** Exited board terminals kept for their output; the oldest go first. */
export const MAX_CLOSED_BOARD_TERMINALS = 16;
/** A zsh or bash whose markers haven't arrived by then is treated like a shell without them. */
export const MARKER_TIMEOUT_MS = 5_000;
/** How long a closing project's board terminals get after Ctrl+C before they are killed. */
export const STOP_GRACE_MS = 3_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point.
const ALT_SCREEN = /\x1b\[\?(?:1049|1047|47)h/;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

export interface PtyManagerOptions {
  store: BoardStore;
  load: () => Promise<PtyLoad>;
  /** The shell to run, `-l` (login) by default. Defaults to `$SHELL`, else `/bin/sh`. */
  shell?: { file: string; args: string[] };
  /** The shell's environment. Defaults to the server's, cleaned of editor variables. */
  env?: () => Record<string, string>;
  max?: number;
  now?: () => number;
  newId?: () => string;
  flushMs?: number;
  /**
   * Where the zsh/bash integration files go (rewritten once per server start). Without it the
   * shells start plain and their commands are inferred from the process table.
   */
  integrationDir?: string;
  markerTimeoutMs?: number;
  /** Receives `exec.start` / `exec.end` for the Pulse timeline. */
  onActivity?: (event: ActivityEvent) => void;
}

export interface PtyCreateOptions {
  projectId: string;
  cwd: string;
  name: string;
  /** Typed into the shell once it starts. */
  command?: string;
}

interface Running {
  execId: string;
  /** The process an inferred execution stands for; null when the shell reported it. */
  pid: number | null;
}

interface Live {
  pty: PtyProcess;
  /** Output not yet written, for the current target (the running execution, else the terminal). */
  pending: string;
  timer: NodeJS.Timeout | undefined;
  dispose: () => void;
  parser: MarkerParser;
  integration: IntegratedShell | null;
  /** A signed marker arrived: the shell reports its own commands. */
  reporting: boolean;
  /** No markers to expect, or they never came: the process table stands in for them. */
  inferring: boolean;
  markerTimer: NodeJS.Timeout | undefined;
  /** The launch command, typed at the first prompt. */
  queued: string | null;
  /** From the last signed `633;E`, for the next execution: a `133;C` without one is ignored. */
  commandLine: string | null;
  cwd: string;
  running: Running | null;
  execCount: number;
}

/** The server's environment for a new shell, without what marks it as an editor's terminal. */
export function shellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key.startsWith('VSCODE_') || key.startsWith('TERM_PROGRAM')) {
      continue;
    }
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function defaultShell(): { file: string; args: string[] } {
  const file = process.env.SHELL?.startsWith('/') ? process.env.SHELL : '/bin/sh';
  return { file, args: ['-l'] };
}

/**
 * Board-owned terminals (PRD F19): a login shell in a pty per terminal, for projects no editor
 * window has open. Output goes into the terminal's ring buffer (`term:<id>`), so the UI streams
 * and replays it like an editor terminal's; keystrokes go straight to the pty. They live as long
 * as the server: UI reconnects keep them, a server stop ends them.
 */
export class PtyManager {
  private readonly store: BoardStore;
  private readonly load: () => Promise<PtyLoad>;
  private readonly shell: { file: string; args: string[] };
  private readonly env: () => Record<string, string>;
  private readonly max: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly flushMs: number;
  private readonly integrationDir: string | undefined;
  private readonly markerTimeoutMs: number;
  private readonly onActivity: ((event: ActivityEvent) => void) | undefined;
  private integrationReady: Promise<boolean> | null = null;
  private readonly live = new Map<string, Live>();
  /** Spawns in flight count against the limit too. */
  private starting = 0;
  private stopped = false;

  constructor(options: PtyManagerOptions) {
    this.store = options.store;
    this.load = options.load;
    this.shell = options.shell ?? defaultShell();
    this.env = options.env ?? (() => shellEnv());
    this.max = options.max ?? MAX_BOARD_TERMINALS;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `board-${randomUUID()}`);
    this.flushMs = options.flushMs ?? PTY_FLUSH_MS;
    this.integrationDir = options.integrationDir;
    this.markerTimeoutMs = options.markerTimeoutMs ?? MARKER_TIMEOUT_MS;
    this.onActivity = options.onActivity;
  }

  get liveCount(): number {
    return this.live.size;
  }

  get limit(): number {
    return this.max;
  }

  /** Whether node-pty loaded, and why not. */
  async availability(): Promise<{ available: boolean; reason: string | null }> {
    const loaded = await this.load();
    return loaded.ok
      ? { available: true, reason: null }
      : { available: false, reason: loaded.reason };
  }

  async create(options: PtyCreateOptions): Promise<ActionResult & { terminalId?: string }> {
    if (this.stopped) return { ok: false, error: PTY_ERRORS.unavailable };
    if (this.live.size + this.starting >= this.max) return { ok: false, error: PTY_ERRORS.tooMany };
    this.starting++;
    let loaded: PtyLoad;
    let integrated: boolean;
    try {
      loaded = await this.load();
      integrated = loaded.ok && (await this.prepareIntegration());
    } finally {
      this.starting--;
    }
    if (!loaded.ok) return { ok: false, error: PTY_ERRORS.unavailable };
    if (this.stopped) return { ok: false, error: PTY_ERRORS.unavailable };
    if (this.live.size >= this.max) return { ok: false, error: PTY_ERRORS.tooMany };

    const launch =
      integrated && this.integrationDir !== undefined
        ? integrateShell(this.shell, this.env(), this.integrationDir)
        : { ...this.shell, env: this.env(), integration: null };
    // Only a shell that signs its markers gets a nonce; any other takes no markers at all.
    const nonce =
      launch.integration !== null || loaded.signsMarkers ? randomBytes(16).toString('hex') : null;
    let pty: PtyProcess;
    try {
      pty = loaded.spawn(launch.file, launch.args, {
        cwd: options.cwd,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        env: nonce === null ? launch.env : { ...launch.env, [MARKER_NONCE_ENV]: nonce },
      });
    } catch {
      return { ok: false, error: PTY_ERRORS.spawnFailed };
    }

    const id = this.newId();
    for (const other of Object.values(this.store.state.terminals)) {
      if (isBoardTerminal(other) && other.projectId === options.projectId && other.active) {
        this.store.upsertTerminal({
          id: other.id,
          windowId: BOARD_WINDOW_ID,
          name: other.name,
          active: false,
        });
      }
    }
    this.store.upsertTerminal({
      id,
      windowId: BOARD_WINDOW_ID,
      origin: 'board',
      name: options.name,
      projectId: options.projectId,
      shellPid: pty.pid > 0 ? pty.pid : null,
      cwd: options.cwd,
      shellIntegration: false,
      active: true,
      createdAt: this.now(),
    });
    this.store.touchProject(options.projectId);

    const command = options.command?.trim() || null;
    const entry: Live = {
      pty,
      pending: '',
      timer: undefined,
      dispose: () => {},
      parser: createMarkerParser(nonce),
      integration: launch.integration,
      reporting: false,
      inferring: launch.integration === null,
      markerTimer: undefined,
      queued: command,
      commandLine: null,
      cwd: options.cwd,
      running: null,
      execCount: 0,
    };
    const data = pty.onData((chunk) => this.onData(id, entry, chunk));
    const exit = pty.onExit(({ exitCode }) => this.onExit(id, entry, exitCode));
    entry.dispose = () => {
      data.dispose();
      exit.dispose();
    };
    this.live.set(id, entry);
    if (entry.inferring) {
      this.typeQueued(entry);
    } else {
      // An rc file that never gets to the hooks (or replaces them) leaves the shell unreported.
      entry.markerTimer = setTimeout(() => {
        entry.markerTimer = undefined;
        if (entry.reporting) return;
        entry.inferring = true;
        this.typeQueued(entry);
      }, this.markerTimeoutMs);
      entry.markerTimer.unref?.();
    }
    return { ok: true, terminalId: id };
  }

  /**
   * The process sampler's tick: a terminal without shell markers runs a command while its shell
   * has a child. The newest child stands for it (argv as the command line, no exit code).
   */
  sample(tree: ProcessTree): void {
    if (this.stopped) return;
    for (const [id, entry] of this.live) {
      if (!entry.inferring || entry.reporting || entry.pty.pid <= 0) continue;
      const children = (tree.children.get(entry.pty.pid) ?? []).filter((pid) =>
        tree.procs.has(pid),
      );
      const running = entry.running;
      if (running?.pid != null && children.includes(running.pid)) continue;
      this.flush(id, entry);
      if (running) this.endExecution(id, entry, null);
      const pid = children.length > 0 ? Math.max(...children) : undefined;
      const proc = pid === undefined ? undefined : tree.procs.get(pid);
      if (proc) this.startExecution(id, entry, proc.command, proc.pid);
    }
  }

  /** `terminal.create` for a project no editor window has: a shell in its folder. */
  createAction(): ActionHandler<'terminal.create'> {
    return async ({ projectId, name, command }) => {
      const project = this.store.state.projects[projectId];
      if (!project) return { ok: false, error: ROUTE_ERRORS.unknownProject };
      const created = await this.create({
        projectId,
        cwd: project.path,
        name: name ?? project.name,
        ...(command !== undefined ? { command } : {}),
      });
      return created.ok ? { ok: true } : created;
    };
  }

  /** Raw keystrokes from the board's xterm. */
  input(terminalId: string, data: string): ActionResult {
    const entry = this.live.get(terminalId);
    if (!entry) return this.missing(terminalId);
    entry.pty.write(data);
    return { ok: true };
  }

  resize(terminalId: string, cols: number, rows: number): ActionResult {
    const entry = this.live.get(terminalId);
    if (!entry) return this.missing(terminalId);
    try {
      entry.pty.resize(Math.max(2, Math.round(cols)), Math.max(1, Math.round(rows)));
    } catch {
      // The pty exited between the check and the resize; its exit closes the terminal.
    }
    return { ok: true };
  }

  /** The command line's `terminal.sendText`: a line, run with Enter when `execute`. */
  sendText(terminalId: string, text: string, execute: boolean): ActionResult {
    return this.input(terminalId, execute ? `${text}\r` : text);
  }

  interrupt(terminalId: string): ActionResult {
    return this.input(terminalId, '\x03');
  }

  /** Ends a running terminal (its exit closes it); an exited one leaves the board. */
  close(terminalId: string): ActionResult {
    const entry = this.live.get(terminalId);
    if (entry) {
      try {
        entry.pty.kill();
      } catch {
        // Already gone; its exit event closes it.
      }
      return { ok: true };
    }
    const terminal = this.store.state.terminals[terminalId];
    if (!terminal || !isBoardTerminal(terminal))
      return { ok: false, error: ROUTE_ERRORS.unknownTerminal };
    this.store.removeTerminal(terminalId);
    return { ok: true };
  }

  /**
   * A project closed: its running board terminals get Ctrl+C, and any still running
   * `graceMs` later are killed.
   */
  stopProject(projectId: string, graceMs = STOP_GRACE_MS): void {
    for (const [id, entry] of this.live) {
      if (this.store.state.terminals[id]?.projectId !== projectId) continue;
      entry.pty.write('\x03');
      const timer = setTimeout(() => {
        if (this.live.get(id) === entry) this.close(id);
      }, graceMs);
      timer.unref?.();
    }
  }

  /** Server stop: every shell ends with it, and nothing writes to the store any more. */
  stopAll(): void {
    this.stopped = true;
    for (const [, entry] of this.live) {
      clearTimeout(entry.timer);
      clearTimeout(entry.markerTimer);
      entry.dispose();
      try {
        entry.pty.kill();
      } catch {
        // Already exited.
      }
    }
    this.live.clear();
  }

  /**
   * Terminal actions with board terminals handled here and every other terminal passed on to
   * `editor` (the editor bridge, or the demo's terminals).
   */
  actions(
    editor: Pick<ActionHandlers, Exclude<TerminalActionKind, 'terminal.create'>>,
  ): Pick<ActionHandlers, Exclude<TerminalActionKind, 'terminal.create'>> {
    const board = (terminalId: string) => {
      const terminal = this.store.state.terminals[terminalId];
      return terminal !== undefined && isBoardTerminal(terminal);
    };
    return {
      'terminal.sendText': (action) =>
        board(action.terminalId)
          ? this.sendText(action.terminalId, action.text, action.execute)
          : editor['terminal.sendText'](action),
      'terminal.interrupt': (action) =>
        board(action.terminalId)
          ? this.interrupt(action.terminalId)
          : editor['terminal.interrupt'](action),
      'terminal.rerun': (action) => {
        const execution = this.store.state.executions[action.execId];
        return execution && board(execution.terminalId)
          ? this.rerun(action.execId)
          : editor['terminal.rerun'](action);
      },
      // Nothing to bring forward: the board's own view is the terminal.
      'terminal.focus': (action) =>
        board(action.terminalId)
          ? this.focusable(action.terminalId)
          : editor['terminal.focus'](action),
      'terminal.close': (action) =>
        board(action.terminalId) ? this.close(action.terminalId) : editor['terminal.close'](action),
    };
  }

  /** Types an earlier command again, once the shell is back at its prompt. */
  rerun(execId: string): ActionResult {
    const execution = this.store.state.executions[execId];
    if (!execution) return { ok: false, error: ROUTE_ERRORS.unknownExecution };
    const entry = this.live.get(execution.terminalId);
    if (!entry) return this.missing(execution.terminalId);
    if (execution.commandLine.trim() === '') return { ok: false, error: NOTHING_TO_RERUN };
    if (!isSafeCommandLine(execution.commandLine)) return { ok: false, error: UNSAFE_COMMAND_LINE };
    if (entry.running) return { ok: false, error: PTY_ERRORS.busy };
    return this.sendText(execution.terminalId, execution.commandLine, true);
  }

  private focusable(terminalId: string): ActionResult {
    return this.live.has(terminalId) ? { ok: true } : this.missing(terminalId);
  }

  private missing(terminalId: string): ActionResult {
    const terminal = this.store.state.terminals[terminalId];
    return {
      ok: false,
      error: terminal ? ROUTE_ERRORS.terminalClosed : ROUTE_ERRORS.unknownTerminal,
    };
  }

  /** Writes the integration files once per server start; false when there are none to use. */
  private prepareIntegration(): Promise<boolean> {
    if (this.integrationDir === undefined || integrationFor(this.shell.file) === null) {
      return Promise.resolve(false);
    }
    const dir = this.integrationDir;
    this.integrationReady ??= writeShellIntegration(dir).then(
      () => true,
      () => false,
    );
    return this.integrationReady;
  }

  private typeQueued(entry: Live): void {
    const command = entry.queued;
    entry.queued = null;
    if (command) entry.pty.write(`${command}\r`);
  }

  private onData(id: string, entry: Live, chunk: string): void {
    if (this.stopped) return;
    for (const token of entry.parser.push(chunk)) {
      if ('text' in token) {
        entry.pending += token.text;
      } else {
        // Output before the marker belongs to what ran before it.
        this.flush(id, entry);
        this.onMarker(id, entry, token.marker);
      }
    }
    if (entry.pending === '') return;
    if (entry.pending.length >= FLUSH_BYTES) {
      this.flush(id, entry);
      return;
    }
    entry.timer ??= setTimeout(() => this.flush(id, entry), this.flushMs);
  }

  private flush(id: string, entry: Live): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const chunk = entry.pending;
    entry.pending = '';
    if (chunk === '') return;
    const running = entry.running;
    if (running) {
      this.store.appendExecOutput(running.execId, chunk);
      if (ALT_SCREEN.test(chunk)) this.store.markExecInteractive(running.execId);
    } else {
      this.store.output.appendTerminal(id, chunk);
    }
    const projectId = this.store.state.terminals[id]?.projectId;
    if (projectId) this.store.touchProject(projectId);
  }

  private onMarker(id: string, entry: Live, marker: ShellMarker): void {
    // Unsigned markers (prompt, run, end) count once a signed one proved the integration runs.
    const signed = marker.kind === 'commandLine' || marker.kind === 'cwd';
    if (!entry.reporting && !signed) return;
    if (!entry.reporting) {
      entry.reporting = true;
      entry.inferring = false;
      clearTimeout(entry.markerTimer);
      entry.markerTimer = undefined;
      if (entry.running) this.endExecution(id, entry, null);
      this.patchTerminal(id, { shellIntegration: true });
    }
    switch (marker.kind) {
      case 'prompt':
        // A prompt while a command runs: its end marker got lost.
        if (entry.running) this.endExecution(id, entry, null);
        this.typeQueued(entry);
        return;
      case 'commandLine':
        entry.commandLine = marker.commandLine;
        return;
      case 'executed': {
        const commandLine = entry.commandLine;
        // Our hooks sign every command line before it runs: a bare `133;C` is printed text.
        if (commandLine === null) return;
        if (entry.running) this.endExecution(id, entry, null);
        entry.commandLine = null;
        this.startExecution(id, entry, commandLine, null);
        return;
      }
      case 'finished':
        if (entry.running) this.endExecution(id, entry, marker.exitCode);
        return;
      case 'cwd':
        if (marker.cwd !== entry.cwd) {
          entry.cwd = marker.cwd;
          this.patchTerminal(id, { cwd: marker.cwd });
        }
        return;
      case 'input':
        return;
    }
  }

  private startExecution(id: string, entry: Live, commandLine: string, pid: number | null): void {
    const execution = this.store.startExec({
      execId: `${id}-e${++entry.execCount}`,
      terminalId: id,
      commandLine,
      confidence: pid === null && commandLine !== '' ? 'high' : 'low',
      cwd: entry.cwd,
      startedAt: this.now(),
      // The shell echoed the command line itself.
      header: false,
      ...(pid !== null ? { inferred: true } : {}),
    });
    if (!execution) return;
    entry.running = { execId: execution.id, pid };
    this.activity('exec.start', execution.id, {});
  }

  private endExecution(id: string, entry: Live, exitCode: number | null): void {
    const running = entry.running;
    if (!running) return;
    entry.running = null;
    this.store.endExec(running.execId, exitCode, this.now());
    if (this.store.state.terminals[id]) {
      this.activity('exec.end', running.execId, { exitCode });
    }
  }

  private activity(
    kind: 'exec.start' | 'exec.end',
    execId: string,
    data: Record<string, unknown>,
  ): void {
    const execution = this.store.state.executions[execId];
    if (!execution || !this.onActivity) return;
    this.onActivity({
      id: randomUUID(),
      ts: this.now(),
      kind,
      projectId: this.store.state.terminals[execution.terminalId]?.projectId ?? null,
      sessionId: null,
      terminalId: execution.terminalId,
      execId,
      summary: execution.commandLine.slice(0, 200) || null,
      data,
    });
  }

  private patchTerminal(id: string, patch: Partial<Pick<Terminal, 'cwd' | 'shellIntegration'>>) {
    const terminal = this.store.state.terminals[id];
    if (!terminal) return;
    this.store.upsertTerminal({ id, windowId: terminal.windowId, name: terminal.name, ...patch });
  }

  private onExit(id: string, entry: Live, exitCode: number): void {
    if (this.stopped || this.live.get(id) !== entry) return;
    entry.pending += entry.parser.flush();
    this.flush(id, entry);
    this.endExecution(id, entry, null);
    clearTimeout(entry.markerTimer);
    entry.dispose();
    this.live.delete(id);
    this.store.closeTerminal(id, exitCode, this.now());
    this.pruneClosed();
  }

  private pruneClosed(): void {
    const closed = Object.values(this.store.state.terminals)
      .filter((t) => isBoardTerminal(t) && t.state === 'closed')
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
    for (const terminal of closed.slice(
      0,
      Math.max(0, closed.length - MAX_CLOSED_BOARD_TERMINALS),
    )) {
      this.store.removeTerminal(terminal.id);
    }
  }
}

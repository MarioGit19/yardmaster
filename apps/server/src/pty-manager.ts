import { randomUUID } from 'node:crypto';
import { BOARD_WINDOW_ID, isBoardTerminal, MAX_BOARD_TERMINALS } from '@c-board/protocol';
import type { ActionHandler, ActionHandlers, ActionResult } from './actions.js';
import type { TerminalActionKind } from './editor-actions.js';
import { ROUTE_ERRORS } from './editor-router.js';
import type { PtyLoad, PtyProcess } from './pty.js';
import type { BoardStore } from './store.js';

export const PTY_ERRORS = {
  /** node-pty isn't installed or didn't load. */
  unavailable: 'pty_unavailable',
  tooMany: 'too_many_terminals',
  spawnFailed: 'pty_spawn_failed',
} as const;

/** Output is batched for this long (or 16 KB), like the extension's `exec.data`. */
export const PTY_FLUSH_MS = 8;
const FLUSH_BYTES = 16 * 1024;
/** Exited board terminals kept for their output; the oldest go first. */
export const MAX_CLOSED_BOARD_TERMINALS = 16;
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
}

export interface PtyCreateOptions {
  projectId: string;
  cwd: string;
  name: string;
  /** Typed into the shell once it starts. */
  command?: string;
}

interface Live {
  pty: PtyProcess;
  pending: string;
  timer: NodeJS.Timeout | undefined;
  dispose: () => void;
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
    try {
      loaded = await this.load();
    } finally {
      this.starting--;
    }
    if (!loaded.ok) return { ok: false, error: PTY_ERRORS.unavailable };
    if (this.stopped) return { ok: false, error: PTY_ERRORS.unavailable };
    if (this.live.size >= this.max) return { ok: false, error: PTY_ERRORS.tooMany };

    let pty: PtyProcess;
    try {
      pty = loaded.spawn(this.shell.file, this.shell.args, {
        cwd: options.cwd,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        env: this.env(),
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

    const entry: Live = { pty, pending: '', timer: undefined, dispose: () => {} };
    const data = pty.onData((chunk) => this.onData(id, entry, chunk));
    const exit = pty.onExit(({ exitCode }) => this.onExit(id, entry, exitCode));
    entry.dispose = () => {
      data.dispose();
      exit.dispose();
    };
    this.live.set(id, entry);
    const command = options.command?.trim();
    if (command) pty.write(`${command}\r`);
    return { ok: true, terminalId: id };
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

  /** Server stop: every shell ends with it, and nothing writes to the store any more. */
  stopAll(): void {
    this.stopped = true;
    for (const [, entry] of this.live) {
      clearTimeout(entry.timer);
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
      // Board terminals have no executions to re-run.
      'terminal.rerun': (action) => editor['terminal.rerun'](action),
      // Nothing to bring forward: the board's own view is the terminal.
      'terminal.focus': (action) =>
        board(action.terminalId)
          ? this.focusable(action.terminalId)
          : editor['terminal.focus'](action),
      'terminal.close': (action) =>
        board(action.terminalId) ? this.close(action.terminalId) : editor['terminal.close'](action),
    };
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

  private onData(id: string, entry: Live, chunk: string): void {
    if (this.stopped) return;
    entry.pending += chunk;
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
    this.store.output.appendTerminal(id, chunk);
    const projectId = this.store.state.terminals[id]?.projectId;
    if (projectId) this.store.touchProject(projectId);
  }

  private onExit(id: string, entry: Live, exitCode: number): void {
    if (this.stopped || this.live.get(id) !== entry) return;
    this.flush(id, entry);
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

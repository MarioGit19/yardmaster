import { randomUUID } from 'node:crypto';
import type { EditorTerminal } from '@c-board/protocol';

const MAX_NAME = 256;
const MAX_PATH = 4_096;

export interface UriLike {
  readonly scheme: string;
  readonly fsPath: string;
}

/** The parts of `vscode.Terminal` the tracker reads, so tests can use plain objects. */
export interface TerminalLike {
  readonly name: string;
  readonly processId: PromiseLike<number | undefined>;
  readonly creationOptions: { readonly name?: string; readonly cwd?: string | UriLike };
  readonly exitStatus: { readonly code: number | undefined } | undefined;
  readonly shellIntegration: { readonly cwd: UriLike | undefined } | undefined;
}

export interface TerminalSink {
  upsert(terminal: EditorTerminal): void;
  closed(terminalId: string, exitCode: number | null): void;
  sync(terminals: EditorTerminal[]): void;
}

export interface TerminalTrackerOptions<T extends TerminalLike> {
  sink: TerminalSink;
  activeTerminal: () => T | undefined;
  newId?: () => string;
}

function localPath(value: string | UriLike | undefined): string | null {
  if (value === undefined) return null;
  const path = typeof value === 'string' ? value : value.scheme === 'file' ? value.fsPath : '';
  return path.startsWith('/') && path.length <= MAX_PATH ? path : null;
}

/**
 * Keeps the window's terminal inventory: gives each terminal a stable id for this
 * activation and reports changes as `terminal.upsert` / `terminal.closed`, plus a full
 * `terminal.sync` on demand (after every connect).
 */
export class TerminalTracker<T extends TerminalLike> {
  private readonly ids = new WeakMap<T, string>();
  /** Resolved shell pids; `null` while unknown or if the editor has none. */
  private readonly pids = new WeakMap<T, number | null>();
  /** Open terminals in the order they were seen. */
  private readonly open = new Set<T>();
  private readonly sink: TerminalSink;
  private readonly activeTerminal: () => T | undefined;
  private readonly newId: () => string;
  private lastActive: T | undefined;

  constructor(options: TerminalTrackerOptions<T>) {
    this.sink = options.sink;
    this.activeTerminal = options.activeTerminal;
    this.newId = options.newId ?? randomUUID;
  }

  /** The terminal's id, assigned on first sight. */
  idOf(terminal: T): string {
    let id = this.ids.get(terminal);
    if (id === undefined) {
      id = this.newId();
      this.ids.set(terminal, id);
    }
    return id;
  }

  /** A terminal opened (or was found already open). */
  opened(terminal: T): void {
    if (terminal.exitStatus !== undefined) return;
    this.open.add(terminal);
    this.sink.upsert(this.describe(terminal));
  }

  /** State, shell integration or cwd may have changed. Unknown terminals are picked up. */
  changed(terminal: T): void {
    if (this.open.has(terminal)) this.sink.upsert(this.describe(terminal));
    else this.opened(terminal);
  }

  activeChanged(): void {
    const previous = this.lastActive;
    const next = this.activeTerminal();
    this.lastActive = next;
    if (previous === next) return;
    if (previous && this.open.has(previous)) this.sink.upsert(this.describe(previous));
    if (next) this.changed(next);
  }

  closed(terminal: T): void {
    if (!this.open.delete(terminal)) return;
    if (this.lastActive === terminal) this.lastActive = undefined;
    this.sink.closed(this.idOf(terminal), terminal.exitStatus?.code ?? null);
  }

  /** Reconciles with the editor's current terminals and sends the full list. */
  sync(current: readonly T[]): void {
    const live = new Set(current.filter((terminal) => terminal.exitStatus === undefined));
    for (const terminal of this.open) if (!live.has(terminal)) this.open.delete(terminal);
    for (const terminal of live) this.open.add(terminal);
    this.lastActive = this.activeTerminal();
    this.sink.sync([...this.open].map((terminal) => this.describe(terminal)));
  }

  describe(terminal: T): EditorTerminal {
    const closed = terminal.exitStatus !== undefined;
    const name = terminal.name || terminal.creationOptions.name || 'terminal';
    return {
      terminalId: this.idOf(terminal),
      name: name.slice(0, MAX_NAME),
      shellPid: this.pidOf(terminal),
      cwd: localPath(terminal.shellIntegration?.cwd) ?? localPath(terminal.creationOptions.cwd),
      state: closed ? 'closed' : 'open',
      shellIntegration: terminal.shellIntegration !== undefined,
      active: !closed && terminal === this.activeTerminal(),
      exitCode: terminal.exitStatus?.code ?? null,
    };
  }

  /** The cached pid; the first call starts resolving it and upserts again once known. */
  private pidOf(terminal: T): number | null {
    if (this.pids.has(terminal)) return this.pids.get(terminal) ?? null;
    this.pids.set(terminal, null);
    Promise.resolve(terminal.processId).then(
      (pid) => {
        if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
        this.pids.set(terminal, pid);
        if (this.open.has(terminal)) this.sink.upsert(this.describe(terminal));
      },
      () => {},
    );
    return null;
  }
}

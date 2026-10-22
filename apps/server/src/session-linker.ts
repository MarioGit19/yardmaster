import type { BoardState, ClaudeSession, PatchOp } from '@c-board/protocol';
import { type ProcessTree, terminalForPid } from './processes.js';
import type { BoardStore } from './store.js';

export interface SessionLinkerOptions {
  store: BoardStore;
  /** The latest process sample, or null before the first one. */
  tree: () => ProcessTree | null;
}

/**
 * Ties Claude sessions to the terminal they run in (PRD §6.6): walks the ancestors of
 * each session's `claudePid` (from the hook header or the session registry) until one
 * is the shell of an open terminal. Re-runs whenever the process tree is resampled or
 * a terminal or session changes.
 */
export class SessionLinker {
  private readonly store: BoardStore;
  private readonly tree: () => ProcessTree | null;
  private unsubscribe: (() => void) | null = null;
  private scheduled = false;

  constructor(options: SessionLinkerOptions) {
    this.store = options.store;
    this.tree = options.tree;
  }

  /** Re-links after every patch that touches terminals or sessions. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.store.onPatch((ops) => {
      if (ops.some(touchesLinks)) this.schedule();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Updates `terminalId` on every session whose link changed. */
  link(): void {
    const tree = this.tree();
    const { sessions, terminals } = this.store.state;
    const shells = tree ? shellIndex(tree, terminals) : new Map<number, string>();
    for (const session of Object.values(sessions)) {
      const next = tree
        ? resolveLink(session, tree, shells, terminals)
        : dangling(session, terminals);
      if (next !== session.terminalId) {
        // Linking isn't session activity, so `updatedAt` stays.
        this.store.updateSession(session.id, { terminalId: next, updatedAt: session.updatedAt });
      }
    }
  }

  // Patches arrive inside the store's flush; link after it so our own writes batch next.
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.unsubscribe) this.link();
    });
  }
}

/** Shell pid → terminal, for open terminals whose shell is in the sample. */
function shellIndex(tree: ProcessTree, terminals: BoardState['terminals']): Map<number, string> {
  const shells = new Map<number, string>();
  for (const terminal of Object.values(terminals)) {
    if (
      terminal.state === 'open' &&
      terminal.shellPid !== null &&
      tree.procs.has(terminal.shellPid)
    )
      shells.set(terminal.shellPid, terminal.id);
  }
  return shells;
}

function resolveLink(
  session: ClaudeSession,
  tree: ProcessTree,
  shells: ReadonlyMap<number, string>,
  terminals: BoardState['terminals'],
): string | null {
  // An ended session's pid may already belong to an unrelated process.
  if (session.claudePid === null || session.status.kind === 'ended') {
    return dangling(session, terminals);
  }
  // A pid that isn't sampled yet (or just exited) keeps the last known link.
  if (!tree.procs.has(session.claudePid)) return dangling(session, terminals);
  return terminalForPid(tree, session.claudePid, shells);
}

/** The current link, unless its terminal is gone from the board. */
function dangling(session: ClaudeSession, terminals: BoardState['terminals']): string | null {
  return session.terminalId !== null && terminals[session.terminalId] ? session.terminalId : null;
}

/** Stats samples land every 2 s and never change a link. */
function touchesLinks(op: PatchOp): boolean {
  const [collection, , field] = op.path;
  if (collection === 'terminals') return field !== 'stats';
  return collection === 'sessions';
}

import { type BoardState, isBoardTerminal, sessionDisplayName } from '@yardmaster/protocol';

/** Close (or forget) a project (12.6e): who asked, from where. The confirm reads it. */
export interface CloseRequest {
  projectId: string;
  forget: boolean;
}

function createRequestStore() {
  const listeners = new Set<() => void>();
  let value: CloseRequest | null = null;
  return {
    get: () => value,
    set(next: CloseRequest | null) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const closeRequest = createRequestStore();

/** Opens the confirm for closing `projectId`, or forgetting it. */
export const requestClose = (projectId: string, forget = false) =>
  closeRequest.set({ projectId, forget });

export interface PlanItem {
  id: string;
  name: string;
}

/** What closing a project does to what runs there, for the confirm to list. */
export interface ClosePlan {
  /** Board terminals still running: Ctrl+C, then killed after 3 s. */
  stop: PlanItem[];
  /** Board Claude sessions still running: interrupted, resumable from History. */
  interrupt: PlanItem[];
  /** Terminal-origin Claude sessions and editor terminals: left running, only hidden. */
  keep: PlanItem[];
  /** Editor windows open on the project, which the user may close too. */
  windows: { id: string; appName: string }[];
}

type Board = Pick<BoardState, 'terminals' | 'sessions' | 'windows'>;

export function closePlan(board: Board, projectId: string): ClosePlan {
  const plan: ClosePlan = { stop: [], interrupt: [], keep: [], windows: [] };
  const claudeTerminals = new Set<string>();
  const sessions = Object.values(board.sessions)
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const session of sessions) {
    const live = session.status.kind !== 'ended' && session.status.kind !== 'interrupted';
    if (!live) continue;
    const item = { id: session.id, name: sessionDisplayName(session) };
    if (session.origin === 'board') plan.interrupt.push(item);
    else {
      plan.keep.push(item);
      if (session.terminalId) claudeTerminals.add(session.terminalId);
    }
  }
  const terminals = Object.values(board.terminals)
    .filter((t) => t.projectId === projectId && t.state === 'open')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const terminal of terminals) {
    const item = { id: terminal.id, name: terminal.name };
    if (isBoardTerminal(terminal)) plan.stop.push(item);
    // A Claude terminal is already listed by its session.
    else if (!claudeTerminals.has(terminal.id)) plan.keep.push(item);
  }
  for (const window of Object.values(board.windows)) {
    if (window.projectIds.includes(projectId)) {
      plan.windows.push({ id: window.id, appName: window.appName || 'Cursor' });
    }
  }
  return plan;
}

/** Settles once the board shows the project closed or gone (the patch can trail the reply). */
export function waitForClosed(
  board: { get(): Pick<BoardState, 'projects'>; subscribe(listener: () => void): () => void },
  projectId: string,
  timeoutMs = 2_000,
): Promise<void> {
  const closed = () => (board.get().projects[projectId]?.closedAt ?? null) !== null;
  const gone = () => board.get().projects[projectId] === undefined;
  if (closed() || gone()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = board.subscribe(() => {
      if (closed() || gone()) done();
    });
  });
}

import type { BoardState, Execution, Project, Terminal } from '@c-board/protocol';

export const ROUTE_ERRORS = {
  unknownTerminal: 'unknown_terminal',
  terminalClosed: 'terminal_closed',
  unknownExecution: 'unknown_execution',
  unknownProject: 'unknown_project',
  /** The owning window is known but its socket is gone (it may be inside the grace period). */
  editorOffline: 'editor_offline',
  /** No editor window has the project open. */
  noEditor: 'no_editor',
} as const;

export type RouteFailure = { ok: false; error: string };
export type Routed<T> = ({ ok: true; windowId: string } & T) | RouteFailure;

export interface EditorRouterOptions {
  state: () => BoardState;
  /** True while the window has a live, greeted connection. */
  isConnected: (windowId: string) => boolean;
}

const fail = (error: string): RouteFailure => ({ ok: false, error });

function contains(folder: string, path: string): boolean {
  if (path === folder) return true;
  return path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

/**
 * Picks the editor window that should run a command: the window owning a terminal (or the
 * terminal of an execution), or the connected window best matching a project.
 */
export class EditorRouter {
  private readonly state: () => BoardState;
  private readonly isConnected: (windowId: string) => boolean;

  constructor(options: EditorRouterOptions) {
    this.state = options.state;
    this.isConnected = options.isConnected;
  }

  /** The window owning an open terminal. */
  forTerminal(terminalId: string): Routed<{ terminal: Terminal }> {
    const terminal = this.state().terminals[terminalId];
    if (!terminal) return fail(ROUTE_ERRORS.unknownTerminal);
    if (terminal.state === 'closed') return fail(ROUTE_ERRORS.terminalClosed);
    if (!this.isConnected(terminal.windowId)) return fail(ROUTE_ERRORS.editorOffline);
    return { ok: true, windowId: terminal.windowId, terminal };
  }

  /** The window owning the (still open) terminal an execution ran in. */
  forExecution(execId: string): Routed<{ terminal: Terminal; execution: Execution }> {
    const execution = this.state().executions[execId];
    if (!execution) return fail(ROUTE_ERRORS.unknownExecution);
    const route = this.forTerminal(execution.terminalId);
    return route.ok ? { ...route, execution } : route;
  }

  /**
   * The connected window with the project as a workspace folder, else the one whose folder
   * contains it most closely. Ties go to the window seen most recently.
   */
  forProject(projectId: string): Routed<{ project: Project }> {
    const state = this.state();
    const project = state.projects[projectId];
    if (!project) return fail(ROUTE_ERRORS.unknownProject);

    let best: { windowId: string; score: number; lastSeenAt: number } | null = null;
    let offlineMatch = false;
    for (const window of Object.values(state.windows)) {
      let score = -1;
      if (window.projectIds.includes(projectId)) score = Number.MAX_SAFE_INTEGER;
      else {
        for (const id of window.projectIds) {
          const folder = state.projects[id]?.path;
          if (folder && contains(folder, project.path)) score = Math.max(score, folder.length);
        }
      }
      if (score < 0) continue;
      if (!this.isConnected(window.id)) {
        offlineMatch = true;
        continue;
      }
      if (
        !best ||
        score > best.score ||
        (score === best.score && window.lastSeenAt > best.lastSeenAt)
      ) {
        best = { windowId: window.id, score, lastSeenAt: window.lastSeenAt };
      }
    }
    if (!best) return fail(offlineMatch ? ROUTE_ERRORS.editorOffline : ROUTE_ERRORS.noEditor);
    return { ok: true, windowId: best.windowId, project };
  }
}

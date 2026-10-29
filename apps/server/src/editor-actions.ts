import {
  type BoardState,
  isSafeCommandLine,
  RESUMABLE_SESSION_ID,
  UNSAFE_COMMAND_LINE,
} from '@yardmaster/protocol';
import type { ActionHandlers, ActionResult } from './actions.js';
import type { CommandPayloads } from './editor-gateway.js';
import type { EditorRouter } from './editor-router.js';

export type CommandSender = <T extends keyof CommandPayloads>(
  windowId: string,
  type: T,
  payload: CommandPayloads[T],
) => Promise<ActionResult>;

export type TerminalActionKind =
  | 'terminal.sendText'
  | 'terminal.interrupt'
  | 'terminal.rerun'
  | 'terminal.create'
  | 'terminal.focus'
  | 'terminal.close';

export type EditorActionKind = TerminalActionKind | 'session.resumeInEditor';

export const NOTHING_TO_RERUN = 'nothing_to_rerun';
export const INVALID_SESSION_ID = 'invalid_session_id';

/** The shell command that resumes a Claude Code session; null for an id unsafe to put in it. */
export function resumeCommand(sessionId: string): string | null {
  return RESUMABLE_SESSION_ID.test(sessionId) ? `claude --resume ${sessionId}` : null;
}

/** Terminal actions from the board, turned into editor commands for the owning window. */
export function createEditorActions(options: {
  router: EditorRouter;
  send: CommandSender;
}): Pick<ActionHandlers, EditorActionKind> {
  const { router, send } = options;
  return {
    'terminal.sendText': ({ terminalId, text, execute }) => {
      const route = router.forTerminal(terminalId);
      if (!route.ok) return route;
      return send(route.windowId, 'cmd.sendText', { terminalId, text, execute });
    },
    'terminal.interrupt': ({ terminalId }) => {
      const route = router.forTerminal(terminalId);
      if (!route.ok) return route;
      return send(route.windowId, 'cmd.interrupt', { terminalId });
    },
    'terminal.rerun': ({ execId }) => {
      const route = router.forExecution(execId);
      if (!route.ok) return route;
      if (route.execution.commandLine.trim() === '') return { ok: false, error: NOTHING_TO_RERUN };
      // The command line came from the terminal's own output: never type control characters.
      if (!isSafeCommandLine(route.execution.commandLine)) {
        return { ok: false, error: UNSAFE_COMMAND_LINE };
      }
      return send(route.windowId, 'cmd.rerun', { execId });
    },
    'terminal.create': ({ projectId, name, command }) => {
      const route = router.forProject(projectId);
      if (!route.ok) return route;
      return send(route.windowId, 'cmd.createTerminal', {
        cwd: route.project.path,
        name: name ?? route.project.name,
        ...(command !== undefined ? { command } : {}),
      });
    },
    'terminal.focus': ({ terminalId }) => {
      const route = router.forTerminal(terminalId);
      if (!route.ok) return route;
      return send(route.windowId, 'cmd.focusTerminal', { terminalId });
    },
    'terminal.close': ({ terminalId }) => {
      const route = router.forTerminal(terminalId);
      if (!route.ok) return route;
      return send(route.windowId, 'cmd.disposeTerminal', { terminalId });
    },
    'session.resumeInEditor': ({ projectId, sessionId }) => {
      const command = resumeCommand(sessionId);
      if (command === null) return { ok: false, error: INVALID_SESSION_ID };
      const route = router.forProject(projectId);
      if (!route.ok) return route;
      return send(route.windowId, 'cmd.createTerminal', {
        cwd: route.project.path,
        name: `claude · ${route.project.name}`,
        command,
      });
    },
  };
}

/** Closes every editor window open on a project (`project.close` with its checkbox ticked). */
export function closeProjectWindows(options: {
  state: () => Pick<BoardState, 'windows'>;
  send: CommandSender;
}): (projectId: string) => Promise<ActionResult> {
  return async (projectId) => {
    const windows = Object.values(options.state().windows).filter((w) =>
      w.projectIds.includes(projectId),
    );
    const results = await Promise.all(
      windows.map((w) => options.send(w.id, 'cmd.closeWindow', {})),
    );
    return results.find((result) => !result.ok) ?? { ok: true };
  };
}

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

export const NOTHING_TO_RERUN = 'nothing_to_rerun';

/** Terminal actions from the board, turned into editor commands for the owning window. */
export function createEditorActions(options: {
  router: EditorRouter;
  send: CommandSender;
}): Pick<ActionHandlers, TerminalActionKind> {
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
  };
}

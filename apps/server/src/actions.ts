import type { UiAction, UiActionKind } from '@c-board/protocol';

/** `sessionId`: the session an action started (`session.create`, a forked resume). */
export type ActionResult = { ok: true; sessionId?: string } | { ok: false; error: string };

export type ActionOf<K extends UiActionKind> = Extract<UiAction, { kind: K }>;

export type ActionHandler<K extends UiActionKind> = (
  action: ActionOf<K>,
) => ActionResult | Promise<ActionResult>;

/** One handler per action kind; the compiler flags a missing kind. */
export type ActionHandlers = { [K in UiActionKind]: ActionHandler<K> };

export type ActionDispatcher = (action: UiAction) => Promise<ActionResult>;

export const NOT_IMPLEMENTED = 'not_implemented';

const notImplemented = (): ActionResult => ({ ok: false, error: NOT_IMPLEMENTED });

/** Placeholder handlers until the editor bridge and session manager land. */
export function stubActionHandlers(): ActionHandlers {
  return {
    'terminal.sendText': notImplemented,
    'terminal.interrupt': notImplemented,
    'terminal.rerun': notImplemented,
    'terminal.create': notImplemented,
    'terminal.focus': notImplemented,
    'terminal.close': notImplemented,
    'session.create': notImplemented,
    'session.resume': notImplemented,
    'session.resumeInEditor': notImplemented,
    'session.interrupt': notImplemented,
    'session.close': notImplemented,
    'session.setModel': notImplemented,
    'session.setPermissionMode': notImplemented,
    'session.replyInTerminal': notImplemented,
    'project.add': notImplemented,
    'project.remove': notImplemented,
    'project.openInEditor': notImplemented,
    'settings.set': notImplemented,
  };
}

/** Routes a validated action to its handler. Handler errors become `{ ok: false }`. */
export function createActionDispatcher(handlers: ActionHandlers): ActionDispatcher {
  return async (action) => {
    const handler = handlers[action.kind] as ActionHandler<typeof action.kind>;
    try {
      return await handler(action);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'action_failed' };
    }
  };
}

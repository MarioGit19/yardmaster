import { type BoardState, terminalReplyBlock } from '@c-board/protocol';
import type { ActionHandler, ActionHandlers } from './actions.js';

export const TERMINAL_REPLY_KEY = 'experimental.terminalReply';
export const TERMINAL_REPLY_DISABLED = 'terminal_reply_disabled';
export const EMPTY_REPLY = 'empty_reply';

/**
 * One line for the terminal: control characters (newlines, ESC, Ctrl+C…) would submit early or
 * drive the TUI, so they become spaces.
 */
export function replyLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point.
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/**
 * F14 (experimental): a reply to a terminal session is typed into its linked terminal and
 * submitted, through the same `terminal.sendText` route as the board's terminal input.
 */
export function createTerminalReply(options: {
  state: () => BoardState;
  enabled: () => boolean;
  sendText: ActionHandler<'terminal.sendText'>;
}): Pick<ActionHandlers, 'session.replyInTerminal'> {
  return {
    'session.replyInTerminal': ({ sessionId, text }) => {
      if (!options.enabled()) return { ok: false, error: TERMINAL_REPLY_DISABLED };
      const session = options.state().sessions[sessionId];
      if (!session) return { ok: false, error: 'unknown_session' };
      const block = terminalReplyBlock(session);
      if (block !== null) return { ok: false, error: block };
      const line = replyLine(text);
      if (line === '') return { ok: false, error: EMPTY_REPLY };
      return options.sendText({
        kind: 'terminal.sendText',
        // terminalReplyBlock has checked it is linked.
        terminalId: session.terminalId as string,
        text: line,
        execute: true,
      });
    },
  };
}

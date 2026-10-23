import {
  type BoardState,
  makeMessage,
  type ServerToUi,
  type SessionStatus,
  terminalReplyBlock,
} from '@c-board/protocol';
import type { ActionHandler, ActionHandlers } from './actions.js';

export const TERMINAL_REPLY_KEY = 'claude.terminalReply';
/** Where 8.x stored the flag, while it was experimental and off by default. */
export const LEGACY_TERMINAL_REPLY_KEY = 'experimental.terminalReply';
export const TERMINAL_REPLY_DISABLED = 'terminal_reply_disabled';
export const EMPTY_REPLY = 'empty_reply';

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
export const ENTER = '\r';
/** Between the pasted text and its Enter, so the TUI has closed the paste before the Enter. */
export const SUBMIT_DELAY_MS = 150;
/** How long a submitted reply has to show up as a new turn before Enter is pressed again. */
export const SUBMIT_CONFIRM_MS = 3_000;

/** Statuses Claude is in at its prompt: a submitted reply moves the session out of them. */
const AT_PROMPT = new Set<SessionStatus['kind']>(['idle', 'waiting_input']);

/**
 * The reply as pasted text: line breaks stay (one `\n` each), every other control character
 * (ESC, which could close the paste early, Ctrl+C…) becomes a space.
 */
export function replyText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point.
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ')
      .trim()
  );
}

/** Bracketed paste: the TUI inserts it literally, newlines included, and submits nothing. */
export function pasted(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * F14: a reply to a terminal session is typed into its linked terminal and submitted, through the
 * same `terminal.sendText` route as the board's terminal input. Claude Code's TUI reads text and
 * Enter arriving in one burst as a paste, where the Enter is a newline, so the text goes in as a
 * bracketed paste and the Enter follows on its own. If no new turn starts, Enter is pressed once
 * more, then the board is told the reply sits unsent in the terminal.
 */
export function createTerminalReply(options: {
  state: () => BoardState;
  enabled: () => boolean;
  sendText: ActionHandler<'terminal.sendText'>;
  /** Called after every board change (the store's patches). */
  onChange: (listener: () => void) => () => void;
  notify: (message: ServerToUi) => void;
}): Pick<ActionHandlers, 'session.replyInTerminal'> {
  const { state, sendText } = options;
  const press = (terminalId: string, text: string) =>
    sendText({ kind: 'terminal.sendText', terminalId, text, execute: false });

  /** Whether the reply turned into a turn: `null` while Claude is still at its prompt. */
  const outcome = (sessionId: string): 'submitted' | 'gone' | null => {
    const session = state().sessions[sessionId];
    if (!session || session.status.kind === 'ended' || session.terminalId === null) return 'gone';
    return AT_PROMPT.has(session.status.kind) ? null : 'submitted';
  };

  /** Resolves once the session leaves its prompt, or with `false` after `ms`. */
  const settles = (sessionId: string, ms: number) =>
    new Promise<boolean>((resolve) => {
      const done = (submitted: boolean) => {
        clearTimeout(timer);
        stop();
        resolve(submitted);
      };
      const timer = setTimeout(() => done(outcome(sessionId) !== null), ms);
      // A pending check never keeps the server from exiting.
      timer.unref();
      const stop = options.onChange(() => {
        if (outcome(sessionId) !== null) done(true);
      });
    });

  const confirm = async (sessionId: string, terminalId: string) => {
    if (await settles(sessionId, SUBMIT_CONFIRM_MS)) return;
    await press(terminalId, ENTER);
    if (await settles(sessionId, SUBMIT_CONFIRM_MS)) return;
    const windowId = state().terminals[terminalId]?.windowId;
    const editor = (windowId && state().windows[windowId]?.appName) || 'Cursor';
    const session = state().sessions[sessionId];
    options.notify(
      makeMessage('toast', {
        level: 'warning',
        title: 'Typed into the terminal but not sent',
        body: `Press Enter in ${editor}.`,
        sessionId,
        terminalId,
        ...(session?.projectId ? { projectId: session.projectId } : {}),
      }),
    );
  };

  return {
    'session.replyInTerminal': async ({ sessionId, text }) => {
      if (!options.enabled()) return { ok: false, error: TERMINAL_REPLY_DISABLED };
      const session = state().sessions[sessionId];
      if (!session) return { ok: false, error: 'unknown_session' };
      const block = terminalReplyBlock(session);
      if (block !== null) return { ok: false, error: block };
      const reply = replyText(text);
      if (reply === '') return { ok: false, error: EMPTY_REPLY };
      // terminalReplyBlock has checked it is linked.
      const terminalId = session.terminalId as string;
      const typed = await press(terminalId, pasted(reply));
      if (!typed.ok) return typed;
      await wait(SUBMIT_DELAY_MS);
      const entered = await press(terminalId, ENTER);
      if (entered.ok) void confirm(sessionId, terminalId);
      return entered;
    },
  };
}

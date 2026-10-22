import { makeMessage, type ServerToEditor } from '@c-board/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_ERRORS,
  CommandHandler,
  type CommandTerminal,
  type EditorFacade,
  SHELL_INTEGRATION_WAIT_MS,
} from './command-handler.js';

/** Records every call the handler makes on a terminal. */
class FakeTerminal implements CommandTerminal {
  shellIntegration: { executeCommand(commandLine: string): unknown } | undefined;
  readonly calls: unknown[][] = [];

  constructor(
    readonly name: string,
    readonly cwd = '/home/dev/acme-shop',
    integrated = true,
  ) {
    if (integrated) this.integrate();
  }

  integrate(): void {
    this.shellIntegration = {
      executeCommand: (commandLine) => this.calls.push(['executeCommand', commandLine]),
    };
  }

  sendText(text: string, shouldExecute?: boolean): void {
    this.calls.push(['sendText', text, shouldExecute]);
  }

  show(preserveFocus?: boolean): void {
    this.calls.push(['show', preserveFocus]);
  }

  dispose(): void {
    this.calls.push(['dispose']);
  }
}

/** A mocked vscode facade with two terminals and one remembered execution. */
class FakeEditor implements EditorFacade<FakeTerminal> {
  readonly terminals = new Map<string, FakeTerminal>([
    ['term-1', new FakeTerminal('zsh')],
    ['term-2', new FakeTerminal('plain', '/home/dev/acme-api', false)],
  ]);
  readonly executions = new Map([
    ['exec-1', { terminalId: 'term-1', commandLine: 'pnpm test' }],
    ['exec-2', { terminalId: 'term-2', commandLine: 'make build' }],
    ['exec-blank', { terminalId: 'term-1', commandLine: ' ' }],
    ['exec-orphan', { terminalId: 'term-gone', commandLine: 'ls' }],
  ]);
  readonly created: FakeTerminal[] = [];
  private listeners = new Set<(terminal: FakeTerminal) => void>();
  createIntegrated = false;

  get listenerCount(): number {
    return this.listeners.size;
  }

  findTerminal(terminalId: string) {
    return this.terminals.get(terminalId);
  }

  createTerminal(options: { name: string; cwd: string }) {
    const terminal = new FakeTerminal(options.name, options.cwd, this.createIntegrated);
    this.created.push(terminal);
    return terminal;
  }

  onShellIntegration(listener: (terminal: FakeTerminal) => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fireShellIntegration(terminal: FakeTerminal): void {
    for (const listener of [...this.listeners]) listener(terminal);
  }

  execution(execId: string) {
    return this.executions.get(execId);
  }
}

let seq = 0;
function cmd<T extends ServerToEditor['type']>(
  type: T,
  payload: Extract<ServerToEditor, { type: T }>['payload'],
): ServerToEditor {
  return makeMessage<ServerToEditor>(type, payload as ServerToEditor['payload'], {
    id: `cmd-${++seq}`,
  });
}

function setup() {
  const editor = new FakeEditor();
  const replies: { id: string; ok: boolean; error?: string }[] = [];
  const handler = new CommandHandler({
    editor,
    reply: (id, ok, error) => replies.push(error === undefined ? { id, ok } : { id, ok, error }),
  });
  return { editor, handler, replies, term1: editor.terminals.get('term-1') as FakeTerminal };
}

describe('CommandHandler', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('sends text, interrupts, focuses and disposes the addressed terminal', async () => {
    const { handler, replies, term1 } = setup();
    await handler.handle(cmd('cmd.sendText', { terminalId: 'term-1', text: 'ls', execute: true }));
    await handler.handle(cmd('cmd.sendText', { terminalId: 'term-1', text: 'y', execute: false }));
    await handler.handle(cmd('cmd.interrupt', { terminalId: 'term-1' }));
    await handler.handle(cmd('cmd.focusTerminal', { terminalId: 'term-1' }));
    await handler.handle(cmd('cmd.disposeTerminal', { terminalId: 'term-1' }));
    expect(term1.calls).toEqual([
      ['sendText', 'ls', true],
      ['sendText', 'y', false],
      ['sendText', '\x03', false],
      ['show', false],
      ['dispose'],
    ]);
    expect(replies).toEqual([1, 2, 3, 4, 5].map((n) => ({ id: `cmd-${n}`, ok: true })));
  });

  it('answers unknown terminals with an error', async () => {
    const { handler, replies } = setup();
    await handler.handle(cmd('cmd.interrupt', { terminalId: 'nope' }));
    await handler.handle(cmd('cmd.focusTerminal', { terminalId: 'nope' }));
    expect(replies).toEqual([
      { id: 'cmd-1', ok: false, error: COMMAND_ERRORS.unknownTerminal },
      { id: 'cmd-2', ok: false, error: COMMAND_ERRORS.unknownTerminal },
    ]);
  });

  it('reruns an execution through shell integration, or types it in without it', async () => {
    const { editor, handler, replies, term1 } = setup();
    await handler.handle(cmd('cmd.rerun', { execId: 'exec-1' }));
    await handler.handle(cmd('cmd.rerun', { execId: 'exec-2' }));
    expect(term1.calls).toEqual([['executeCommand', 'pnpm test']]);
    expect(editor.terminals.get('term-2')?.calls).toEqual([['sendText', 'make build', true]]);

    await handler.handle(cmd('cmd.rerun', { execId: 'missing' }));
    await handler.handle(cmd('cmd.rerun', { execId: 'exec-blank' }));
    await handler.handle(cmd('cmd.rerun', { execId: 'exec-orphan' }));
    expect(replies).toEqual([
      { id: 'cmd-1', ok: true },
      { id: 'cmd-2', ok: true },
      { id: 'cmd-3', ok: false, error: COMMAND_ERRORS.unknownExecution },
      { id: 'cmd-4', ok: false, error: COMMAND_ERRORS.nothingToRerun },
      { id: 'cmd-5', ok: false, error: COMMAND_ERRORS.unknownTerminal },
    ]);
  });

  it('reports editor errors as a failed result', async () => {
    const { handler, replies, term1 } = setup();
    term1.dispose = () => {
      throw new Error('terminal already disposed');
    };
    await handler.handle(cmd('cmd.disposeTerminal', { terminalId: 'term-1' }));
    expect(replies).toEqual([{ id: 'cmd-1', ok: false, error: 'terminal already disposed' }]);
  });

  describe('createTerminal', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('creates and shows a terminal without a command', async () => {
      const { editor, handler, replies } = setup();
      await handler.handle(cmd('cmd.createTerminal', { cwd: '/home/dev/acme-api', name: 'api' }));
      expect(editor.created).toHaveLength(1);
      expect(editor.created[0]).toMatchObject({ name: 'api', cwd: '/home/dev/acme-api' });
      expect(editor.created[0]?.calls).toEqual([['show', false]]);
      expect(replies).toEqual([{ id: 'cmd-1', ok: true }]);
    });

    it('runs the command once shell integration activates', async () => {
      const { editor, handler, replies } = setup();
      const done = handler.handle(
        cmd('cmd.createTerminal', { cwd: '/home/dev/acme-api', name: 'dev', command: 'pnpm dev' }),
      );
      const terminal = editor.created[0] as FakeTerminal;
      await vi.advanceTimersByTimeAsync(500);
      expect(replies).toEqual([]);

      // Another terminal's integration is not the one we wait for.
      editor.fireShellIntegration(editor.terminals.get('term-1') as FakeTerminal);
      terminal.integrate();
      editor.fireShellIntegration(terminal);
      await done;
      expect(terminal.calls).toEqual([
        ['show', false],
        ['executeCommand', 'pnpm dev'],
      ]);
      expect(replies).toEqual([{ id: 'cmd-1', ok: true }]);
      expect(editor.listenerCount).toBe(0);
      await vi.advanceTimersByTimeAsync(SHELL_INTEGRATION_WAIT_MS);
      expect(terminal.calls).toHaveLength(2);
    });

    it('falls back to sendText after 3 s without shell integration', async () => {
      const { editor, handler, replies } = setup();
      const done = handler.handle(
        cmd('cmd.createTerminal', { cwd: '/home/dev/acme-api', name: 'dev', command: 'pnpm dev' }),
      );
      const terminal = editor.created[0] as FakeTerminal;
      await vi.advanceTimersByTimeAsync(SHELL_INTEGRATION_WAIT_MS - 1);
      expect(terminal.calls).toEqual([['show', false]]);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(terminal.calls).toEqual([
        ['show', false],
        ['sendText', 'pnpm dev', true],
      ]);
      expect(replies).toEqual([{ id: 'cmd-1', ok: true }]);
      expect(editor.listenerCount).toBe(0);

      // A late activation does not run it again.
      terminal.integrate();
      editor.fireShellIntegration(terminal);
      expect(terminal.calls).toHaveLength(2);
    });

    it('runs right away when the terminal already has shell integration', async () => {
      const { editor, handler } = setup();
      editor.createIntegrated = true;
      await handler.handle(
        cmd('cmd.createTerminal', { cwd: '/home/dev/acme-api', name: 'dev', command: 'pnpm dev' }),
      );
      expect(editor.created[0]?.calls).toEqual([
        ['show', false],
        ['executeCommand', 'pnpm dev'],
      ]);
      expect(editor.listenerCount).toBe(0);
    });

    it('types pending commands in on dispose', async () => {
      const { editor, handler, replies } = setup();
      const done = handler.handle(
        cmd('cmd.createTerminal', { cwd: '/home/dev/acme-api', name: 'dev', command: 'make' }),
      );
      handler.dispose();
      await done;
      expect(editor.created[0]?.calls.at(-1)).toEqual(['sendText', 'make', true]);
      expect(replies).toEqual([{ id: 'cmd-1', ok: true }]);
    });
  });
});

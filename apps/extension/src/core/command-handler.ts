import type { ServerToEditor } from '@c-board/protocol';

/** How long a new terminal gets to activate shell integration before its command is typed in. */
export const SHELL_INTEGRATION_WAIT_MS = 3_000;
const MAX_ERROR = 1_000;

export const COMMAND_ERRORS = {
  unknownTerminal: 'unknown_terminal',
  unknownExecution: 'unknown_execution',
  nothingToRerun: 'nothing_to_rerun',
} as const;

/** The parts of `vscode.Terminal` the handler drives. */
export interface CommandTerminal {
  readonly shellIntegration: { executeCommand(commandLine: string): unknown } | undefined;
  sendText(text: string, shouldExecute?: boolean): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface Disposable {
  dispose(): void;
}

/** The editor operations the handler needs, so tests can run it without `vscode`. */
export interface EditorFacade<T extends CommandTerminal> {
  findTerminal(terminalId: string): T | undefined;
  createTerminal(options: { name: string; cwd: string }): T;
  /** Fires when a terminal's shell integration activates or changes. */
  onShellIntegration(listener: (terminal: T) => void): Disposable;
  /** A recent execution of this activation. */
  execution(execId: string): { terminalId: string; commandLine: string } | undefined;
}

export interface CommandHandlerOptions<T extends CommandTerminal> {
  editor: EditorFacade<T>;
  /** Sends `cmd.result`. */
  reply: (id: string, ok: boolean, error?: string) => void;
  shellIntegrationWaitMs?: number;
}

type Outcome = { ok: true } | { ok: false; error: string };
const fail = (error: string): Outcome => ({ ok: false, error });

/** Runs a command line through shell integration when it is active, otherwise types it in. */
function run(terminal: CommandTerminal, commandLine: string): void {
  if (terminal.shellIntegration) terminal.shellIntegration.executeCommand(commandLine);
  else terminal.sendText(commandLine, true);
}

/** Executes server commands (`cmd.*`) against the editor and answers each with `cmd.result`. */
export class CommandHandler<T extends CommandTerminal> {
  private readonly editor: EditorFacade<T>;
  private readonly reply: CommandHandlerOptions<T>['reply'];
  private readonly waitMs: number;
  /** Pending waits for shell integration; settled early on dispose. */
  private readonly waits = new Set<() => void>();

  constructor(options: CommandHandlerOptions<T>) {
    this.editor = options.editor;
    this.reply = options.reply;
    this.waitMs = options.shellIntegrationWaitMs ?? SHELL_INTEGRATION_WAIT_MS;
  }

  async handle(command: ServerToEditor): Promise<void> {
    let outcome: Outcome;
    try {
      outcome = await this.execute(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = fail(message.slice(0, MAX_ERROR) || 'command_failed');
    }
    if (outcome.ok) this.reply(command.id, true);
    else this.reply(command.id, false, outcome.error);
  }

  /** Stops waiting for shell integration; pending commands are typed in right away. */
  dispose(): void {
    for (const settle of [...this.waits]) settle();
  }

  private async execute(command: ServerToEditor): Promise<Outcome> {
    switch (command.type) {
      case 'cmd.sendText':
        return this.withTerminal(command.payload.terminalId, (terminal) =>
          terminal.sendText(command.payload.text, command.payload.execute),
        );
      case 'cmd.interrupt':
        return this.withTerminal(command.payload.terminalId, (terminal) =>
          terminal.sendText('\x03', false),
        );
      case 'cmd.focusTerminal':
        return this.withTerminal(command.payload.terminalId, (terminal) => terminal.show(false));
      case 'cmd.disposeTerminal':
        return this.withTerminal(command.payload.terminalId, (terminal) => terminal.dispose());
      case 'cmd.rerun': {
        const execution = this.editor.execution(command.payload.execId);
        if (!execution) return fail(COMMAND_ERRORS.unknownExecution);
        if (execution.commandLine.trim() === '') return fail(COMMAND_ERRORS.nothingToRerun);
        return this.withTerminal(execution.terminalId, (terminal) =>
          run(terminal, execution.commandLine),
        );
      }
      case 'cmd.createTerminal': {
        const { name, cwd, command: commandLine } = command.payload;
        const terminal = this.editor.createTerminal({ name, cwd });
        terminal.show(false);
        if (commandLine !== undefined && commandLine.trim() !== '') {
          await this.runWhenReady(terminal, commandLine);
        }
        return { ok: true };
      }
    }
  }

  private withTerminal(terminalId: string, action: (terminal: T) => void): Outcome {
    const terminal = this.editor.findTerminal(terminalId);
    if (!terminal) return fail(COMMAND_ERRORS.unknownTerminal);
    action(terminal);
    return { ok: true };
  }

  /**
   * A new terminal's shell integration activates shortly after its shell starts. Waits for it so
   * the command is tracked as an execution, and falls back to typing it in after the wait.
   */
  private runWhenReady(terminal: T, commandLine: string): Promise<void> {
    if (terminal.shellIntegration) {
      run(terminal, commandLine);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let subscription: Disposable | undefined;
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        subscription?.dispose();
        this.waits.delete(settle);
        run(terminal, commandLine);
        resolve();
      };
      const timer = setTimeout(settle, this.waitMs);
      this.waits.add(settle);
      subscription = this.editor.onShellIntegration((changed) => {
        if (changed === terminal && terminal.shellIntegration) settle();
      });
      if (done) subscription.dispose();
    });
  }
}

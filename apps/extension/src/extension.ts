import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { CommandHandler } from './core/command-handler.js';
import {
  authUrl,
  COMMANDS,
  CONFIG_SECTION,
  type ExtensionConfig,
  editorSocketUrl,
  linkSettingsChanged,
  resolveConfig,
} from './core/config.js';
import { EditorLink, type HelloPayload, type LinkStatus } from './core/editor-link.js';
import { ExecStreamer } from './core/exec-streamer.js';
import { STATUS_TEXT, statusTooltip } from './core/status.js';
import { NAME_POLL_MS, TerminalTracker } from './core/terminal-tracker.js';
import { cboardHome, readToken } from './core/token.js';

const WINDOW_ID_KEY = 'cboard.windowId';
const CLOSE_WINDOW_DELAY_MS = 200;

function readConfig(): ExtensionConfig {
  const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return resolveConfig({ enabled: section.get('enabled'), port: section.get('port') });
}

/**
 * Stable per workspace, so a reloaded window keeps its identity. Empty windows share one
 * workspaceState, so each of those gets a fresh id instead.
 */
function windowIdFor(context: vscode.ExtensionContext): string {
  if (!vscode.workspace.workspaceFolders?.length) return randomUUID();
  const stored = context.workspaceState.get<string>(WINDOW_ID_KEY);
  if (stored) return stored;
  const id = randomUUID();
  void context.workspaceState.update(WINDOW_ID_KEY, id);
  return id;
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('c-board', { log: true });
  const home = cboardHome(process.env, homedir());
  const windowId = windowIdFor(context);
  const extensionVersion = String(context.extension.packageJSON.version ?? '0.0.0');
  let config = readConfig();
  let link: EditorLink | null = null;
  log.info(`activated (enabled: ${config.enabled}, port: ${config.port})`);

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.name = 'c-board';
  statusItem.text = STATUS_TEXT;
  statusItem.command = COMMANDS.openDashboard;
  const terminals = new TerminalTracker<vscode.Terminal>({
    sink: {
      upsert: (terminal) => link?.send('terminal.upsert', terminal),
      closed: (terminalId, exitCode) => link?.send('terminal.closed', { terminalId, exitCode }),
      sync: (list) => link?.send('terminal.sync', { terminals: list }),
    },
    activeTerminal: () => vscode.window.activeTerminal,
  });
  // Cursor may lag behind VS Code's API; without shell execution events only the inventory works.
  const shellExecution = typeof vscode.window.onDidStartTerminalShellExecution === 'function';
  if (!shellExecution) log.warn('shell execution events are unavailable; output is not mirrored');
  const executions = new ExecStreamer<vscode.TerminalShellExecution>({
    sink: {
      start: (payload) => link?.send('exec.start', payload),
      data: (execId, seq, chunk) => link?.send('exec.data', { execId, seq, chunk }),
      interactive: (execId) => link?.send('exec.interactive', { execId }),
      end: (execId, exitCode) => link?.send('exec.end', { execId, exitCode }),
    },
    onError: (message) => log.warn(message),
  });
  const commands = new CommandHandler<vscode.Terminal>({
    editor: {
      findTerminal: (terminalId) => terminals.find(terminalId),
      createTerminal: ({ name, cwd }) => vscode.window.createTerminal({ name, cwd }),
      onShellIntegration: (listener) =>
        vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) => listener(terminal)),
      execution: (execId) => executions.lookup(execId),
      // A beat later, so the `cmd.result` reaches the board before the window goes.
      closeWindow: () =>
        setTimeout(
          () => void vscode.commands.executeCommand('workbench.action.closeWindow'),
          CLOSE_WINDOW_DELAY_MS,
        ),
    },
    reply: (id, ok, error) =>
      link?.send('cmd.result', error === undefined ? { id, ok } : { id, ok, error }),
  });
  // Renaming a terminal tab fires no event, so names are polled.
  const namePoll = setInterval(() => terminals.refreshNames(), NAME_POLL_MS);
  const showStatus = (status: LinkStatus) => {
    statusItem.tooltip = statusTooltip(status, config.port);
    // Every (re)connect gets the full list, so the server drops anything stale.
    if (status.kind === 'connected') terminals.sync(vscode.window.terminals);
  };
  showStatus({ kind: 'stopped' });
  statusItem.show();

  const hello = (): HelloPayload => ({
    windowId,
    appName: vscode.env.appName,
    appVersion: vscode.version,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath),
    extensionVersion,
    capabilities: { shellExecution },
  });

  const startLink = () => {
    link?.stop();
    link = null;
    if (!config.enabled) {
      showStatus({ kind: 'stopped' });
      return;
    }
    link = new EditorLink({
      url: editorSocketUrl(config.port),
      readToken: () => readToken(home),
      hello,
      onStatus: showStatus,
      onCommand: (command) => {
        log.debug(`command ${command.type}`);
        void commands.handle(command);
      },
      logger: log,
    });
    link.start();
  };
  startLink();

  context.subscriptions.push(
    log,
    statusItem,
    {
      dispose: () => {
        clearInterval(namePoll);
        commands.dispose();
        executions.dispose();
        link?.stop();
      },
    },
    vscode.commands.registerCommand(COMMANDS.openDashboard, async () => {
      const url = authUrl(config.port, await readToken(home));
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
      if (!opened) log.warn('the editor declined to open the dashboard');
    }),
    vscode.commands.registerCommand(COMMANDS.reconnect, () => {
      if (!link) {
        void vscode.window.showInformationMessage(
          'c-board is turned off. Enable "cboard.enabled" in the settings to connect.',
        );
        return;
      }
      log.info('reconnect requested');
      link.reconnect();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => link?.sendHello()),
    vscode.window.onDidOpenTerminal((terminal) => terminals.opened(terminal)),
    vscode.window.onDidCloseTerminal((terminal) => {
      executions.terminalClosed(terminals.idOf(terminal));
      terminals.closed(terminal);
    }),
    vscode.window.onDidChangeTerminalState((terminal) => terminals.changed(terminal)),
    vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) =>
      terminals.changed(terminal),
    ),
    vscode.window.onDidChangeActiveTerminal(() => terminals.activeChanged()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) terminals.refreshNames();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      const next = readConfig();
      const changed = linkSettingsChanged(config, next);
      config = next;
      if (!changed) return;
      log.info(`settings changed (enabled: ${next.enabled}, port: ${next.port})`);
      startLink();
    }),
  );
  if (shellExecution) {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
        // Make sure the server knows the terminal before its first execution.
        terminals.changed(terminal);
        // Reading must start inside this handler, or the first output is lost.
        executions.started(execution, terminals.idOf(terminal));
      }),
      vscode.window.onDidEndTerminalShellExecution(({ terminal, execution, exitCode }) => {
        executions.ended(execution, exitCode);
        // The cwd can change with every command; there is no dedicated event for it.
        terminals.changed(terminal);
      }),
    );
  }
}

export function deactivate(): void {}

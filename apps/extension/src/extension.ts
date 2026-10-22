import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
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
import { STATUS_TEXT, statusTooltip } from './core/status.js';
import { TerminalTracker } from './core/terminal-tracker.js';
import { cboardHome, readToken } from './core/token.js';

const WINDOW_ID_KEY = 'cboard.windowId';

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
      logger: log,
    });
    link.start();
  };
  startLink();

  context.subscriptions.push(
    log,
    statusItem,
    { dispose: () => link?.stop() },
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
    vscode.window.onDidCloseTerminal((terminal) => terminals.closed(terminal)),
    vscode.window.onDidChangeTerminalState((terminal) => terminals.changed(terminal)),
    vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) =>
      terminals.changed(terminal),
    ),
    // The cwd can change with every command; there is no dedicated event for it.
    vscode.window.onDidEndTerminalShellExecution(({ terminal }) => terminals.changed(terminal)),
    vscode.window.onDidChangeActiveTerminal(() => terminals.activeChanged()),
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
}

export function deactivate(): void {}

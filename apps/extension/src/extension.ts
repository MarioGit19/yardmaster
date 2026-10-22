import * as vscode from 'vscode';
import {
  COMMANDS,
  CONFIG_SECTION,
  dashboardUrl,
  type ExtensionConfig,
  linkSettingsChanged,
  resolveConfig,
} from './core/config.js';

function readConfig(): ExtensionConfig {
  const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return resolveConfig({ enabled: section.get('enabled'), port: section.get('port') });
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('c-board', { log: true });
  let config = readConfig();
  log.info(`activated (enabled: ${config.enabled}, port: ${config.port})`);

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand(COMMANDS.openDashboard, async () => {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl(config.port)));
      if (!opened) log.warn('the editor declined to open the dashboard');
    }),
    vscode.commands.registerCommand(COMMANDS.reconnect, () => {
      // The server link arrives in task 5.2; until then there is nothing to reconnect.
      log.info('reconnect requested');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      const next = readConfig();
      if (linkSettingsChanged(config, next)) {
        log.info(`settings changed (enabled: ${next.enabled}, port: ${next.port})`);
      }
      config = next;
    }),
  );
}

export function deactivate(): void {}

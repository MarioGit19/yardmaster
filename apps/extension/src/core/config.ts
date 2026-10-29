export const CONFIG_SECTION = 'yardmaster';
/** Settings and extension id from before the rename to Yardmaster, honoured for one version. */
export const LEGACY_CONFIG_SECTION = 'cboard';
export const LEGACY_EXTENSION_ID = 'c-board.c-board-extension';

export const COMMANDS = {
  openDashboard: 'yardmaster.openDashboard',
  reconnect: 'yardmaster.reconnect',
} as const;

export interface ExtensionConfig {
  enabled: boolean;
}

/** Raw values as read from the editor settings, which users can set to anything. */
export interface RawConfig {
  enabled?: unknown;
}

/** What `WorkspaceConfiguration.inspect` reports for a key. */
export interface InspectedSetting {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * The user's own value only. A cloned repo's `.vscode/settings.json` must not be able to
 * steer or switch off the link, even in Restricted Mode, so workspace values never count
 * (the manifest also marks the setting `machine`-scoped).
 */
export function userValue(found: InspectedSetting | undefined): unknown {
  return found?.globalValue;
}

/** `raw` holds the values the user set; a setting left unset falls back to its old `cboard.*` key. */
export function resolveConfig(raw: RawConfig, legacy: RawConfig = {}): ExtensionConfig {
  const enabled = raw.enabled ?? legacy.enabled;
  return { enabled: typeof enabled === 'boolean' ? enabled : true };
}

/** True when a settings change needs the server link to be rebuilt. */
export function linkSettingsChanged(prev: ExtensionConfig, next: ExtensionConfig): boolean {
  return prev.enabled !== next.enabled;
}

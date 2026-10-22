export const CONFIG_SECTION = 'cboard';
export const DEFAULT_PORT = 4317;
export const SERVER_HOST = '127.0.0.1';

export const COMMANDS = {
  openDashboard: 'c-board.openDashboard',
  reconnect: 'c-board.reconnect',
} as const;

export interface ExtensionConfig {
  enabled: boolean;
  port: number;
}

/** Raw values as read from the editor settings, which users can set to anything. */
export interface RawConfig {
  enabled?: unknown;
  port?: unknown;
}

export function parsePort(value: unknown): number {
  const port = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : DEFAULT_PORT;
}

export function resolveConfig(raw: RawConfig): ExtensionConfig {
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    port: parsePort(raw.port),
  };
}

/** True when a settings change needs the server link to be rebuilt. */
export function linkSettingsChanged(prev: ExtensionConfig, next: ExtensionConfig): boolean {
  return prev.enabled !== next.enabled || prev.port !== next.port;
}

export function serverOrigin(port: number): string {
  return `http://${SERVER_HOST}:${port}`;
}

export function dashboardUrl(port: number): string {
  return `${serverOrigin(port)}/`;
}

/** The one-time link that signs the browser in (PRD §8); the plain dashboard without a token. */
export function authUrl(port: number, token: string | null): string {
  if (token === null) return dashboardUrl(port);
  return `${serverOrigin(port)}/auth?t=${encodeURIComponent(token)}`;
}

export function editorSocketUrl(port: number): string {
  return `ws://${SERVER_HOST}:${port}/ws/editor`;
}

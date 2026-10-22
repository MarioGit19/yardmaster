import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = '127.0.0.1';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ServerConfig {
  port: number;
  host: string;
  home: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function isLoopbackHost(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (h === 'localhost') return true;
  if (isIP(h) === 4) return h.split('.')[0] === '127';
  if (isIP(h) === 6) return h === '::1' || /^(0{0,4}:){7}0{0,3}1$/.test(h);
  return false;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(raw.trim()))
    throw new ConfigError(`CBOARD_PORT must be an integer, got "${raw}"`);
  const port = Number(raw.trim());
  if (port > 65535) throw new ConfigError(`CBOARD_PORT must be 0-65535, got ${port}`);
  return port;
}

function parseHost(raw: string | undefined): string {
  const host = raw?.trim() || DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new ConfigError(`CBOARD_HOST must be a loopback address, refusing "${host}"`);
  }
  return host;
}

function parseHome(raw: string | undefined, home: string): string {
  const value = raw?.trim();
  if (!value) return join(home, '.c-board');
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'info';
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new ConfigError(`CBOARD_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ServerConfig {
  return {
    port: parsePort(env.CBOARD_PORT),
    host: parseHost(env.CBOARD_HOST),
    home: parseHome(env.CBOARD_HOME, home),
    logLevel: parseLogLevel(env.CBOARD_LOG_LEVEL),
  };
}

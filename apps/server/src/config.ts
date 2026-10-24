import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { envValue } from './legacy.js';

export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = '127.0.0.1';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ServerConfig {
  port: number;
  host: string;
  home: string;
  logLevel: LogLevel;
  /** Extra browser origins allowed besides the board's own, e.g. the Vite dev server. */
  devOrigins: string[];
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
    throw new ConfigError(`YARDMASTER_PORT must be an integer, got "${raw}"`);
  const port = Number(raw.trim());
  if (port > 65535) throw new ConfigError(`YARDMASTER_PORT must be 0-65535, got ${port}`);
  return port;
}

function parseHost(raw: string | undefined): string {
  const host = raw?.trim() || DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new ConfigError(`YARDMASTER_HOST must be a loopback address, refusing "${host}"`);
  }
  return host;
}

function parseHome(raw: string | undefined, home: string): string {
  const value = raw?.trim();
  if (!value) return join(home, '.yardmaster');
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'info';
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new ConfigError(
    `YARDMASTER_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`,
  );
}

function parseDevOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(',').map((entry) => {
    const value = entry.trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ConfigError(`YARDMASTER_DEV_ORIGINS entry is not a URL: "${value}"`);
    }
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname) || url.origin !== value) {
      throw new ConfigError(
        `YARDMASTER_DEV_ORIGINS entries must be loopback http origins like http://localhost:5173, got "${value}"`,
      );
    }
    return url.origin;
  });
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ServerConfig {
  return {
    port: parsePort(envValue(env, 'PORT')),
    host: parseHost(envValue(env, 'HOST')),
    home: parseHome(envValue(env, 'HOME'), home),
    logLevel: parseLogLevel(envValue(env, 'LOG_LEVEL')),
    devOrigins: parseDevOrigins(envValue(env, 'DEV_ORIGINS')),
  };
}

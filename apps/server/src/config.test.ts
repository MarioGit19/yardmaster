import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackHost, loadConfig } from './config.js';

const HOME = '/home/dev';

describe('loadConfig', () => {
  it('uses defaults when the env is empty', () => {
    expect(loadConfig({}, HOME)).toEqual({
      port: 4317,
      host: '127.0.0.1',
      home: '/home/dev/.yardmaster',
      logLevel: 'info',
      devOrigins: [],
    });
  });

  it('reads YARDMASTER_PORT, YARDMASTER_HOST, YARDMASTER_HOME and YARDMASTER_LOG_LEVEL', () => {
    const config = loadConfig(
      {
        YARDMASTER_PORT: '5000',
        YARDMASTER_HOST: 'localhost',
        YARDMASTER_HOME: '/tmp/cb-test',
        YARDMASTER_LOG_LEVEL: 'DEBUG',
      },
      HOME,
    );
    expect(config).toEqual({
      port: 5000,
      host: 'localhost',
      home: '/tmp/cb-test',
      logLevel: 'debug',
      devOrigins: [],
    });
  });

  it('expands ~ and resolves relative homes', () => {
    expect(loadConfig({ YARDMASTER_HOME: '~/board' }, HOME).home).toBe('/home/dev/board');
    expect(loadConfig({ YARDMASTER_HOME: '~' }, HOME).home).toBe('/home/dev');
    expect(loadConfig({ YARDMASTER_HOME: 'rel/dir' }, HOME).home).toBe(resolve('rel/dir'));
  });

  it('treats blank values as unset', () => {
    expect(
      loadConfig({ YARDMASTER_PORT: ' ', YARDMASTER_HOST: '', YARDMASTER_HOME: '' }, HOME),
    ).toMatchObject({
      port: 4317,
      host: '127.0.0.1',
      home: '/home/dev/.yardmaster',
    });
  });

  it('falls back to the old CBOARD_* variables, and prefers the new ones', () => {
    const legacy = {
      CBOARD_PORT: '5001',
      CBOARD_HOST: 'localhost',
      CBOARD_HOME: '/home/dev/old-board',
      CBOARD_LOG_LEVEL: 'warn',
      CBOARD_DEV_ORIGINS: 'http://localhost:5173',
    };
    expect(loadConfig(legacy, HOME)).toEqual({
      port: 5001,
      host: 'localhost',
      home: '/home/dev/old-board',
      logLevel: 'warn',
      devOrigins: ['http://localhost:5173'],
    });
    expect(
      loadConfig({ ...legacy, YARDMASTER_PORT: '5002', YARDMASTER_HOME: '' }, HOME),
    ).toMatchObject({ port: 5002, home: '/home/dev/old-board' });
  });

  it('allows port 0 for an ephemeral port', () => {
    expect(loadConfig({ YARDMASTER_PORT: '0' }, HOME).port).toBe(0);
  });

  it.each(['abc', '-1', '4317.5', '65536', '0x10'])('rejects YARDMASTER_PORT=%s', (port) => {
    expect(() => loadConfig({ YARDMASTER_PORT: port }, HOME)).toThrow(ConfigError);
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', '10.0.0.1', 'example.test', '[::]'])(
    'refuses non-loopback YARDMASTER_HOST=%s',
    (host) => {
      expect(() => loadConfig({ YARDMASTER_HOST: host }, HOME)).toThrow(/loopback/);
    },
  );

  it('parses YARDMASTER_DEV_ORIGINS as a comma-separated list of loopback origins', () => {
    expect(
      loadConfig({ YARDMASTER_DEV_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173' }, HOME)
        .devOrigins,
    ).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it.each([
    'http://evil.example.test:5173',
    'https://localhost:5173',
    'http://localhost:5173/app',
    'nope',
  ])('rejects dev origin %s', (origin) => {
    expect(() => loadConfig({ YARDMASTER_DEV_ORIGINS: origin }, HOME)).toThrow(ConfigError);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ YARDMASTER_LOG_LEVEL: 'loud' }, HOME)).toThrow(ConfigError);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '128.0.0.1', '::', '::2', 'localhost.example.test', ''])(
    'rejects %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

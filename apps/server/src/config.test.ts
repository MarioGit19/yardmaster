import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackHost, loadConfig } from './config.js';

const HOME = '/home/dev';

describe('loadConfig', () => {
  it('uses defaults when the env is empty', () => {
    expect(loadConfig({}, HOME)).toEqual({
      port: 4317,
      host: '127.0.0.1',
      home: '/home/dev/.c-board',
      logLevel: 'info',
    });
  });

  it('reads CBOARD_PORT, CBOARD_HOST, CBOARD_HOME and CBOARD_LOG_LEVEL', () => {
    const config = loadConfig(
      {
        CBOARD_PORT: '5000',
        CBOARD_HOST: 'localhost',
        CBOARD_HOME: '/tmp/cb-test',
        CBOARD_LOG_LEVEL: 'DEBUG',
      },
      HOME,
    );
    expect(config).toEqual({
      port: 5000,
      host: 'localhost',
      home: '/tmp/cb-test',
      logLevel: 'debug',
    });
  });

  it('expands ~ and resolves relative homes', () => {
    expect(loadConfig({ CBOARD_HOME: '~/board' }, HOME).home).toBe('/home/dev/board');
    expect(loadConfig({ CBOARD_HOME: '~' }, HOME).home).toBe('/home/dev');
    expect(loadConfig({ CBOARD_HOME: 'rel/dir' }, HOME).home).toBe(resolve('rel/dir'));
  });

  it('treats blank values as unset', () => {
    expect(loadConfig({ CBOARD_PORT: ' ', CBOARD_HOST: '', CBOARD_HOME: '' }, HOME)).toMatchObject({
      port: 4317,
      host: '127.0.0.1',
      home: '/home/dev/.c-board',
    });
  });

  it('allows port 0 for an ephemeral port', () => {
    expect(loadConfig({ CBOARD_PORT: '0' }, HOME).port).toBe(0);
  });

  it.each(['abc', '-1', '4317.5', '65536', '0x10'])('rejects CBOARD_PORT=%s', (port) => {
    expect(() => loadConfig({ CBOARD_PORT: port }, HOME)).toThrow(ConfigError);
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', '10.0.0.1', 'example.test', '[::]'])(
    'refuses non-loopback CBOARD_HOST=%s',
    (host) => {
      expect(() => loadConfig({ CBOARD_HOST: host }, HOME)).toThrow(/loopback/);
    },
  );

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ CBOARD_LOG_LEVEL: 'loud' }, HOME)).toThrow(ConfigError);
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

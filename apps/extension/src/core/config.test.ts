import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  dashboardUrl,
  linkSettingsChanged,
  parsePort,
  resolveConfig,
} from './config.js';

describe('parsePort', () => {
  it('accepts integers in range', () => {
    expect(parsePort(4317)).toBe(4317);
    expect(parsePort(1)).toBe(1);
    expect(parsePort(65535)).toBe(65535);
  });

  it('accepts numeric strings from hand-edited settings', () => {
    expect(parsePort(' 5000 ')).toBe(5000);
  });

  it.each([0, -1, 65536, 4317.5, Number.NaN, '43a', '', null, undefined, true, {}])(
    'falls back to the default for %s',
    (value) => {
      expect(parsePort(value)).toBe(DEFAULT_PORT);
    },
  );
});

describe('resolveConfig', () => {
  it('defaults to enabled on the default port', () => {
    expect(resolveConfig({})).toEqual({ enabled: true, port: DEFAULT_PORT });
  });

  it('keeps valid values', () => {
    expect(resolveConfig({ enabled: false, port: 5123 })).toEqual({ enabled: false, port: 5123 });
  });

  it('ignores a non-boolean enabled flag', () => {
    expect(resolveConfig({ enabled: 'no' }).enabled).toBe(true);
  });
});

describe('linkSettingsChanged', () => {
  const base = { enabled: true, port: 4317 };

  it('is false when nothing relevant changed', () => {
    expect(linkSettingsChanged(base, { ...base })).toBe(false);
  });

  it('is true when the port or enabled flag changes', () => {
    expect(linkSettingsChanged(base, { ...base, port: 4318 })).toBe(true);
    expect(linkSettingsChanged(base, { ...base, enabled: false })).toBe(true);
  });
});

describe('dashboardUrl', () => {
  it('always points at loopback', () => {
    expect(dashboardUrl(4317)).toBe('http://127.0.0.1:4317/');
  });
});

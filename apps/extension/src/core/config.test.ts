import { describe, expect, it } from 'vitest';
import { linkSettingsChanged, resolveConfig, userValue } from './config.js';

describe('resolveConfig', () => {
  it('defaults to enabled', () => {
    expect(resolveConfig({})).toEqual({ enabled: true });
  });

  it('keeps a valid value', () => {
    expect(resolveConfig({ enabled: false })).toEqual({ enabled: false });
  });

  it('ignores a non-boolean enabled flag', () => {
    expect(resolveConfig({ enabled: 'no' }).enabled).toBe(true);
  });
});

describe('userValue', () => {
  it('reads only the user value, never a workspace or folder one', () => {
    // A cloned repo's .vscode/settings.json can set these, even in Restricted Mode.
    expect(userValue({ workspaceValue: false, workspaceFolderValue: false })).toBeUndefined();
    expect(
      userValue({ globalValue: true, workspaceValue: false, workspaceFolderValue: false }),
    ).toBe(true);
    expect(userValue(undefined)).toBeUndefined();
  });

  it('leaves a workspace that turns the link off without effect', () => {
    const found = { workspaceValue: false };
    expect(resolveConfig({ enabled: userValue(found) })).toEqual({ enabled: true });
  });
});

describe('linkSettingsChanged', () => {
  it('is true only when the enabled flag changes', () => {
    expect(linkSettingsChanged({ enabled: true }, { enabled: true })).toBe(false);
    expect(linkSettingsChanged({ enabled: true }, { enabled: false })).toBe(true);
  });
});

describe('settings from before the rename', () => {
  it('fall back to the old cboard.* key when the new one is unset', () => {
    expect(resolveConfig({}, { enabled: false })).toEqual({ enabled: false });
    expect(resolveConfig({ enabled: true }, { enabled: false })).toEqual({ enabled: true });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS, CONFIG_SECTION } from './config.js';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('extension manifest', () => {
  it('contributes every command the code registers', () => {
    const contributed = manifest.contributes.commands.map((c: { command: string }) => c.command);
    expect(contributed.sort()).toEqual(Object.values(COMMANDS).sort());
  });

  it('declares settings that match the code defaults', () => {
    const props = manifest.contributes.configuration.properties;
    expect(props[`${CONFIG_SECTION}.enabled`].default).toBe(true);
  });

  it('lets no workspace steer the link', () => {
    const props = manifest.contributes.configuration.properties;
    // Machine scope: settable in user settings only, not in a repo's .vscode/settings.json.
    expect(props[`${CONFIG_SECTION}.enabled`].scope).toBe('machine');
    // The link goes through the board's socket, so there is no port to point elsewhere.
    expect(Object.keys(props)).toEqual([`${CONFIG_SECTION}.enabled`]);
  });

  it('activates on startup so executions are captured from the start', () => {
    expect(manifest.activationEvents).toEqual(['onStartupFinished']);
    expect(manifest.engines.vscode).toBe('^1.93.0');
    expect(manifest.main).toBe('dist/extension.js');
  });
});

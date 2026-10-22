import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS, CONFIG_SECTION, DEFAULT_PORT } from './config.js';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('extension manifest', () => {
  it('contributes every command the code registers', () => {
    const contributed = manifest.contributes.commands.map((c: { command: string }) => c.command);
    expect(contributed.sort()).toEqual(Object.values(COMMANDS).sort());
  });

  it('declares settings that match the code defaults', () => {
    const props = manifest.contributes.configuration.properties;
    expect(props[`${CONFIG_SECTION}.enabled`].default).toBe(true);
    expect(props[`${CONFIG_SECTION}.port`].default).toBe(DEFAULT_PORT);
  });

  it('activates on startup so executions are captured from the start', () => {
    expect(manifest.activationEvents).toEqual(['onStartupFinished']);
    expect(manifest.engines.vscode).toBe('^1.93.0');
    expect(manifest.main).toBe('dist/extension.js');
  });
});

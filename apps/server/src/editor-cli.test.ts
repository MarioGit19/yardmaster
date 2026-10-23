import { describe, expect, it } from 'vitest';
import {
  EDITOR_LAUNCH_FAILED,
  EDITOR_NOT_FOUND,
  type EditorCliDeps,
  EditorLauncher,
  editorAppFor,
  findEditorCli,
  type Spawner,
} from './editor-cli.js';

const CURSOR_BUNDLE = '/Applications/Cursor.app/Contents/Resources/app/bin/cursor';

function deps(executables: string[], platform: NodeJS.Platform = 'linux'): EditorCliDeps {
  return {
    env: { PATH: '/usr/local/bin:/usr/bin' },
    platform,
    home: '/home/dev',
    isExecutable: async (path) => executables.includes(path),
  };
}

function recorder(result: Awaited<ReturnType<Spawner>> = { ok: true }) {
  const calls: [string, string[]][] = [];
  const spawn: Spawner = async (file, args) => {
    calls.push([file, args]);
    return result;
  };
  return { calls, spawn };
}

describe('findEditorCli', () => {
  it('prefers cursor over code on PATH', async () => {
    expect(await findEditorCli(deps(['/usr/bin/code', '/usr/bin/cursor']))).toEqual({
      path: '/usr/bin/cursor',
      app: 'Cursor',
      configured: false,
    });
  });

  it('falls back to code', async () => {
    expect(await findEditorCli(deps(['/usr/bin/code']))).toMatchObject({
      path: '/usr/bin/code',
      app: 'VS Code',
    });
  });

  it('looks inside the app bundles on macOS only', async () => {
    expect(await findEditorCli(deps([CURSOR_BUNDLE], 'darwin'))).toMatchObject({
      path: CURSOR_BUNDLE,
      app: 'Cursor',
    });
    expect(await findEditorCli(deps([CURSOR_BUNDLE], 'linux'))).toBeNull();
    const userApps =
      '/home/dev/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    expect(await findEditorCli(deps([userApps], 'darwin'))).toMatchObject({ app: 'VS Code' });
  });

  it('uses a configured path, and nothing else', async () => {
    const found = deps(['/opt/tools/cursor', '/usr/bin/code']);
    expect(await findEditorCli(found, '/opt/tools/cursor')).toEqual({
      path: '/opt/tools/cursor',
      app: 'Cursor',
      configured: true,
    });
    expect(await findEditorCli(found, '/opt/tools/missing')).toBeNull();
    expect(await findEditorCli(found, 'cursor')).toBeNull();
  });

  it('returns null when nothing is installed', async () => {
    expect(await findEditorCli(deps([]))).toBeNull();
  });
});

describe('editorAppFor', () => {
  it('names VS Code only for its own CLI', () => {
    expect(editorAppFor('/usr/bin/code')).toBe('VS Code');
    expect(editorAppFor('/usr/bin/code-insiders')).toBe('VS Code');
    expect(editorAppFor('/opt/tools/cursor')).toBe('Cursor');
    expect(editorAppFor('/opt/tools/codex')).toBe('Cursor');
  });
});

describe('EditorLauncher', () => {
  it('runs the CLI with the folder as its single argument', async () => {
    const { calls, spawn } = recorder();
    const launcher = new EditorLauncher({
      configured: () => null,
      deps: deps(['/usr/bin/cursor']),
      spawn,
    });
    const folder = '/home/dev/acme shop; rm -rf ~';
    expect(await launcher.open(folder)).toEqual({ ok: true, editor: 'Cursor' });
    expect(calls).toEqual([['/usr/bin/cursor', [folder]]]);
  });

  it('reads the configured path on every launch', async () => {
    const { calls, spawn } = recorder();
    let configured: string | null = null;
    const launcher = new EditorLauncher({
      configured: () => configured,
      deps: deps(['/usr/bin/cursor', '/opt/vscode/code']),
      spawn,
    });
    await launcher.open('/home/dev/acme-shop');
    configured = '/opt/vscode/code';
    expect(await launcher.open('/home/dev/acme-shop')).toEqual({ ok: true, editor: 'VS Code' });
    expect(calls.map(([file]) => file)).toEqual(['/usr/bin/cursor', '/opt/vscode/code']);
  });

  it('refuses a relative folder, which could read as a flag', async () => {
    const { calls, spawn } = recorder();
    const launcher = new EditorLauncher({
      configured: () => null,
      deps: deps(['/usr/bin/cursor']),
      spawn,
    });
    expect(await launcher.open('--disable-extensions')).toEqual({
      ok: false,
      error: EDITOR_LAUNCH_FAILED,
    });
    expect(calls).toEqual([]);
  });

  it('reports a missing CLI and a failed spawn', async () => {
    const missing = new EditorLauncher({
      configured: () => null,
      deps: deps([]),
      spawn: recorder().spawn,
    });
    expect(await missing.open('/home/dev/acme-shop')).toEqual({
      ok: false,
      error: EDITOR_NOT_FOUND,
    });
    const failing = new EditorLauncher({
      configured: () => null,
      deps: deps(['/usr/bin/cursor']),
      spawn: recorder({ ok: false, error: EDITOR_LAUNCH_FAILED }).spawn,
    });
    expect(await failing.open('/home/dev/acme-shop')).toEqual({
      ok: false,
      error: EDITOR_LAUNCH_FAILED,
    });
  });
});

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import type { EditorApp } from '@yardmaster/protocol';

export interface EditorCli {
  path: string;
  app: EditorApp;
  /** Set in Settings rather than found on PATH or in an app bundle. */
  configured: boolean;
}

export interface EditorCliDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  isExecutable(path: string): Promise<boolean>;
}

/** Starts `file args…`; resolves once it is running, or with the spawn error. */
export type Spawner = (
  file: string,
  args: string[],
) => Promise<{ ok: true } | { ok: false; error: string }>;

export const EDITOR_NOT_FOUND = 'editor_not_found';
export const EDITOR_LAUNCH_FAILED = 'editor_launch_failed';

const CANDIDATES: readonly { name: string; app: EditorApp; bundle: string }[] = [
  { name: 'cursor', app: 'Cursor', bundle: 'Cursor.app' },
  { name: 'code', app: 'VS Code', bundle: 'Visual Studio Code.app' },
];

/** A configured CLI's editor, from its file name; Cursor unless it looks like VS Code's `code`. */
export function editorAppFor(path: string): EditorApp {
  return /^code(-insiders)?(\.cmd|\.exe)?$/i.test(basename(path)) ? 'VS Code' : 'Cursor';
}

export async function findOnPath(deps: EditorCliDeps, name: string): Promise<string | undefined> {
  const dirs = (deps.env.PATH ?? deps.env.Path ?? '').split(delimiter).filter(Boolean);
  const exts =
    deps.platform === 'win32'
      ? (deps.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await deps.isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The editor CLI to open folders with: the path set in Settings, else `cursor`, else `code`,
 * each on PATH or (macOS) inside the app bundle, where a server started outside a login shell
 * still finds it. Null when none is there.
 */
export async function findEditorCli(
  deps: EditorCliDeps,
  configured?: string | null,
): Promise<EditorCli | null> {
  if (configured) {
    if (!isAbsolute(configured) || !(await deps.isExecutable(configured))) return null;
    return { path: configured, app: editorAppFor(configured), configured: true };
  }
  for (const { name, app, bundle } of CANDIDATES) {
    const onPath = await findOnPath(deps, name);
    if (onPath) return { path: onPath, app, configured: false };
    if (deps.platform !== 'darwin') continue;
    for (const apps of ['/Applications', join(deps.home, 'Applications')]) {
      const inBundle = join(apps, bundle, 'Contents/Resources/app/bin', name);
      if (await deps.isExecutable(inBundle)) return { path: inBundle, app, configured: false };
    }
  }
  return null;
}

export function defaultEditorCliDeps(env: NodeJS.ProcessEnv = process.env): EditorCliDeps {
  return {
    env,
    platform: process.platform,
    home: homedir(),
    isExecutable: async (path) => {
      try {
        await access(path, constants.X_OK);
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** `execFile` with an argument array (never a shell); the editor CLI exits once the window opens. */
export const execFileSpawner: Spawner = (file, args) =>
  new Promise((done) => {
    const child = execFile(file, args, { timeout: 30_000, windowsHide: true }, () => {});
    child.once('spawn', () => done({ ok: true }));
    child.once('error', (err: NodeJS.ErrnoException) =>
      done({ ok: false, error: err.code === 'ENOENT' ? EDITOR_NOT_FOUND : EDITOR_LAUNCH_FAILED }),
    );
  });

export interface EditorLauncherOptions {
  /** The CLI path set in Settings, if any. */
  configured: () => string | null;
  deps?: EditorCliDeps;
  spawn?: Spawner;
}

/** Opens a folder in Cursor (or VS Code) through its CLI, the folder as a single argument. */
export class EditorLauncher {
  private readonly configured: () => string | null;
  private readonly deps: EditorCliDeps;
  private readonly spawn: Spawner;

  constructor(options: EditorLauncherOptions) {
    this.configured = options.configured;
    this.deps = options.deps ?? defaultEditorCliDeps();
    this.spawn = options.spawn ?? execFileSpawner;
  }

  find(): Promise<EditorCli | null> {
    return findEditorCli(this.deps, this.configured());
  }

  async open(
    folder: string,
  ): Promise<{ ok: true; editor: EditorApp } | { ok: false; error: string }> {
    // A realpath is absolute; anything else could be read as a flag.
    if (!isAbsolute(folder)) return { ok: false, error: EDITOR_LAUNCH_FAILED };
    const cli = await this.find();
    if (!cli) return { ok: false, error: EDITOR_NOT_FOUND };
    const result = await this.spawn(cli.path, [folder]);
    return result.ok ? { ok: true, editor: cli.app } : result;
  }
}

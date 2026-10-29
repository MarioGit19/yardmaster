import { access, chmod, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The slice of a node-pty process the board uses. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

export type PtyLoad =
  | {
      ok: true;
      spawn: PtySpawn;
      /** The processes sign shell markers themselves (the demo shell), so they get a nonce too. */
      signsMarkers?: boolean;
    }
  | { ok: false; reason: string };

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: PtySpawnOptions & { name: string; encoding: 'utf8' },
  ): PtyProcess;
}

/**
 * node-pty's macOS prebuilds ship `spawn-helper` without the executable bit in some releases,
 * and every spawn then fails with `posix_spawnp failed`. Restores it; best effort.
 */
async function repairSpawnHelper(): Promise<void> {
  if (process.platform === 'win32') return;
  let root: string;
  try {
    root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return;
  }
  const helpers = [
    join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(root, 'build', 'Release', 'spawn-helper'),
  ];
  for (const helper of helpers) {
    try {
      await access(helper, constants.F_OK);
    } catch {
      continue;
    }
    try {
      await access(helper, constants.X_OK);
    } catch {
      await chmod(helper, 0o755).catch(() => {});
    }
  }
}

let loading: Promise<PtyLoad> | null = null;

/**
 * Loads node-pty, an optional dependency (prebuilt binaries). When it isn't installed or its
 * native part doesn't load, board terminals are off and `reason` says why.
 */
export function loadNodePty(): Promise<PtyLoad> {
  loading ??= (async (): Promise<PtyLoad> => {
    try {
      const imported = (await import('node-pty')) as unknown as
        | NodePtyModule
        | { default: NodePtyModule };
      const mod = 'spawn' in imported ? imported : imported.default;
      if (typeof mod?.spawn !== 'function') return { ok: false, reason: 'node-pty has no spawn' };
      await repairSpawnHelper();
      return {
        ok: true,
        spawn: (file, args, options) =>
          mod.spawn(file, args, { ...options, name: 'xterm-256color', encoding: 'utf8' }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `node-pty did not load: ${message.split('\n')[0]}` };
    }
  })();
  return loading;
}

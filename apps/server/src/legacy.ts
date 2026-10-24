import { lstat, mkdir, readlink, rename, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Yardmaster was called c-board. Everything the old name left on a machine is read here, for
// one version, so an upgrade keeps its data, its hooks and its signed-in browsers.

export const LEGACY_HOME_DIR = '.c-board';
export const LEGACY_ENV_PREFIX = 'CBOARD_';
export const LEGACY_TOKEN_HEADER = 'x-cboard-token';
export const LEGACY_CLAUDE_PID_HEADER = 'x-cboard-claude-pid';
export const LEGACY_SESSION_COOKIE = 'cboard_session';
export const LEGACY_DEVICE_COOKIE = 'cboard_device';
export const LEGACY_COMMAND = 'c-board';
export const LEGACY_NOTICE = '`c-board` is now `yardmaster`; the old name stops working soon.\n';

/** `YARDMASTER_<name>`, else the old `CBOARD_<name>`. Blank values count as unset. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const key of [`YARDMASTER_${name}`, `${LEGACY_ENV_PREFIX}${name}`]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/** The first value of a header, under its new name or its old one. */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
  legacy: string,
): string | undefined {
  for (const key of [name, legacy]) {
    const value = headers[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
  }
  return undefined;
}

export type HomeMigration =
  | { kind: 'moved'; from: string }
  | { kind: 'none' }
  | { kind: 'failed'; from: string; error: string };

async function kindOf(path: string): Promise<'missing' | 'link' | 'other'> {
  try {
    return (await lstat(path)).isSymbolicLink() ? 'link' : 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
}

/**
 * Moves the old `~/.c-board` data dir to the new one on first start and leaves a symlink at
 * the old path, so an old extension or hook script still finds the token. Never overwrites:
 * once the new dir exists, or the old path is already a link, nothing happens.
 */
export async function migrateHome(home: string, legacy: string): Promise<HomeMigration> {
  try {
    if ((await kindOf(home)) !== 'missing') return { kind: 'none' };
    const old = await kindOf(legacy);
    if (old === 'missing') return { kind: 'none' };
    if (old === 'link') {
      // Left by an earlier migration whose target has since gone: nothing to move.
      const target = resolve(dirname(legacy), await readlink(legacy));
      if (target === resolve(home)) return { kind: 'none' };
    }
    await mkdir(dirname(home), { recursive: true });
    await rename(legacy, home);
    await symlink(home, legacy, 'dir');
    return { kind: 'moved', from: legacy };
  } catch (err) {
    return {
      kind: 'failed',
      from: legacy,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The data dir to migrate from, or null when the user chose a home through the environment. */
export function legacyHomeFor(env: NodeJS.ProcessEnv, home: string): string | null {
  return envValue(env, 'HOME') === undefined ? join(home, LEGACY_HOME_DIR) : null;
}

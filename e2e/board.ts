import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = fileURLToPath(new URL('../apps/server/', import.meta.url));
const TSX = join(SERVER_DIR, 'node_modules', '.bin', 'tsx');
const BOOT_TIMEOUT_MS = 30_000;

export interface DemoBoard {
  /** Origin, e.g. `http://127.0.0.1:51234`. */
  url: string;
  /** A browser session secret, signed in through a one-time `/auth?c=` link. */
  session: string;
  /** The throwaway `YARDMASTER_HOME`. */
  home: string;
  /** The throwaway `CLAUDE_CONFIG_DIR` (inside `home`). */
  claudeDir: string;
  /** Kills the server (SIGTERM) and removes its throwaway home. Safe to call twice. */
  stop(): Promise<void>;
}

/** Resolves with the one-time sign-in URL the CLI prints once the server is listening. */
function waitForAuthUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error('timed out')), BOOT_TIMEOUT_MS);
    const fail = (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`Yardmaster did not start: ${err.message}\n${output}`));
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /(http:\/\/\S+\/auth\?c=\S+)/.exec(output);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`exited with code ${code}`)));
  });
}

/** The secret a sign-in or pairing page hands to the board's origin, or null. */
export function sessionFromPage(html: string): string | null {
  return /<meta name="yardmaster-session" content="([^"]+)">/.exec(html)?.[1] ?? null;
}

/**
 * Boots `yardmaster start --demo --no-open` on a random port with a throwaway home, then signs in
 * through the one-time `/auth?c=` link and returns the origin and the session secret.
 */
export function startDemoBoard(): Promise<DemoBoard> {
  return startBoard({ demo: true });
}

/**
 * Like `startDemoBoard`, optionally without `--demo` (a fresh, empty board) or with
 * `--demo-stress`. The Claude config dir is a throwaway one too, so it never reads or writes
 * the real `~/.claude`.
 */
export async function startBoard({
  demo,
  stress = false,
  projects,
  built = false,
}: {
  demo: boolean;
  stress?: boolean;
  /** With `stress`: how many projects (`--demo-projects`). */
  projects?: number;
  /** Run the build (`dist/`, as `pnpm board` does) instead of the sources through tsx. */
  built?: boolean;
}): Promise<DemoBoard> {
  const home = await mkdtemp(join(tmpdir(), 'yardmaster-e2e-'));
  const claudeDir = join(home, 'claude');
  const mode = stress
    ? ['--demo-stress', ...(projects ? ['--demo-projects', String(projects)] : [])]
    : demo
      ? ['--demo']
      : [];
  const [command, entry] = built ? [process.execPath, ['dist/cli.js']] : [TSX, ['src/cli.ts']];
  const args = [...entry, 'start', ...mode, '--no-open'];
  const child = spawn(command, args, {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      YARDMASTER_PORT: '0',
      YARDMASTER_HOME: home,
      YARDMASTER_LOG_LEVEL: 'warn',
      CLAUDE_CONFIG_DIR: claudeDir,
      YARDMASTER_CLAUDE_BIN: join(claudeDir, 'no-claude'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  };

  try {
    const authUrl = await waitForAuthUrl(child);
    const response = await fetch(authUrl, { redirect: 'manual' });
    const session = sessionFromPage(await response.text());
    if (response.status !== 200 || !session) {
      throw new Error(`sign-in through /auth failed with HTTP ${response.status}`);
    }
    return { url: new URL(authUrl).origin, session, home, claudeDir, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

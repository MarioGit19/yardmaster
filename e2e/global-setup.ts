import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_COOKIE, E2E_URL } from './env.js';

const SERVER_DIR = fileURLToPath(new URL('../apps/server/', import.meta.url));
const TSX = join(SERVER_DIR, 'node_modules', '.bin', 'tsx');
const BOOT_TIMEOUT_MS = 30_000;

/** Resolves with the sign-in URL the CLI prints once the server is listening. */
function waitForAuthUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error('timed out')), BOOT_TIMEOUT_MS);
    const fail = (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`c-board did not start: ${err.message}\n${output}`));
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /(http:\/\/\S+\/auth\?t=\S+)/.exec(output);
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

/**
 * Boots `c-board start --demo --no-open` on a random port with a throwaway home, then signs in
 * through `/auth?t=` and hands the base URL and session cookie to the workers via env.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), 'c-board-e2e-'));
  const child = spawn(TSX, ['src/cli.ts', 'start', '--demo', '--no-open'], {
    cwd: SERVER_DIR,
    env: { ...process.env, CBOARD_PORT: '0', CBOARD_HOME: home, CBOARD_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const teardown = async () => {
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
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (response.status !== 302 || !cookie) {
      throw new Error(`sign-in through /auth failed with HTTP ${response.status}`);
    }
    process.env[E2E_URL] = new URL(authUrl).origin;
    process.env[E2E_COOKIE] = cookie;
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}

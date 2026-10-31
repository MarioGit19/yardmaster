import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../bin/yardmaster-statusline', import.meta.url));
// Synthetic, shaped like a real token (43 base64url chars).
const TOKEN = `synthetic_${'x'.repeat(33)}`;
const INPUT = `${JSON.stringify({
  session_id: '0f3c2a9e-5b7d-4c1e-9a8f-2d6b4e1c7a35',
  cwd: '/home/dev/acme-shop',
  rate_limits: { five_hour: { used_percentage: 42, resets_at: 1738425600 } },
  note: `quotes " and 'single' and $HOME and \\ and ünïcode`,
})}\n\n`;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

let home: string;
let servers: Server[];

/** Resolves on `close`: only once every holder of stdout has let go, as Claude Code would see it. */
function run(previous: string | undefined, stdin = INPUT): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(SCRIPT, previous === undefined ? [] : [previous], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

function dataDir(): string {
  const dir = join(home, '.yardmaster');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  return dir;
}

interface Delivery {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A board on the socket. `hang`: it reads the request and never answers. */
function board(onDelivery: (delivery: Delivery) => void, hang = false): Promise<void> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      onDelivery({ url: req.url, headers: req.headers, body });
      if (!hang) res.writeHead(204).end();
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(join(dataDir(), 'board.sock'), resolve));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ym-statusline-'));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  rmSync(home, { recursive: true, force: true });
});

describe('yardmaster-statusline', () => {
  it('gives the previous command the same stdin and passes its output through unchanged', async () => {
    const seen = join(home, 'seen');
    const result = await run(`cat > ${seen}; printf 'one\\n\\033[32mtwo\\033[0m  '`);
    expect(result).toMatchObject({ code: 0, stdout: 'one\n\u001b[32mtwo\u001b[0m  ', stderr: '' });
    expect(readFileSync(seen, 'utf8')).toBe(INPUT);
  });

  it('forwards stdin to the board over the socket, with the token and not on argv', async () => {
    const delivery = new Promise<Delivery>((resolve) => void board(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await run('cat >/dev/null; echo mine');
    expect(result.stdout).toBe('mine\n');
    const { url, headers, body } = await delivery;
    expect(url).toBe('/api/hooks/statusline');
    expect(headers['x-yardmaster-token']).toBe(TOKEN);
    expect(headers['content-type']).toBe('application/json');
    expect(body).toBe(INPUT);
  });

  it('passes the exit status through, since Claude Code drops the output of a failure', async () => {
    expect((await run('cat >/dev/null; echo partial; exit 3')).code).toBe(3);
  });

  it('runs a previous command that never reads stdin', async () => {
    const big = JSON.stringify({ padding: 'x'.repeat(256 * 1024) });
    expect(await run('echo steady', big)).toMatchObject({
      code: 0,
      stdout: 'steady\n',
      stderr: '',
    });
  });

  it('keeps a bash-only previous command working', async () => {
    const result = await run('read -r line; [[ -n "$line" ]] && cat <<< ok');
    expect(result.stdout).toBe('ok\n');
  });

  it('works when no previous command exists', async () => {
    expect(await run(undefined)).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await run('')).toMatchObject({ code: 0, stdout: '' });
  });

  it('exits fast when the board is down', async () => {
    dataDir();
    const result = await run('cat >/dev/null; echo shown');
    expect(result).toMatchObject({ code: 0, stdout: 'shown\n', stderr: '' });
    expect(result.ms).toBeLessThan(400);
  });

  it('skips a stale socket path that is not a socket', async () => {
    writeFileSync(join(dataDir(), 'board.sock'), '');
    expect(await run('echo shown')).toMatchObject({ code: 0, stdout: 'shown\n', stderr: '' });
  });

  it('never waits for a board that does not answer', async () => {
    const delivered = new Promise<Delivery>((resolve) => void board(resolve, true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await run('cat >/dev/null; echo shown');
    expect(result).toMatchObject({ code: 0, stdout: 'shown\n' });
    expect(result.ms).toBeLessThan(400);
    await delivered;
  });

  it('forwards nothing without a valid token', async () => {
    let calls = 0;
    await board(() => {
      calls++;
    });
    writeFileSync(join(home, '.yardmaster', 'token'), 'not a token\n');
    expect((await run('echo shown')).stdout).toBe('shown\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(0);
  });
});

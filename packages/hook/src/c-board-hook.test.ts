import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../bin/c-board-hook', import.meta.url));
// Synthetic, shaped like a real token (43 base64url chars).
const TOKEN = `synthetic_${'x'.repeat(33)}`;
const PAYLOAD = JSON.stringify({
  session_id: '0f3c2a9e-5b7d-4c1e-9a8f-2d6b4e1c7a35',
  hook_event_name: 'PreToolUse',
  cwd: '/home/dev/acme-shop',
  tool_name: 'Bash',
  tool_input: { command: 'echo "hi" && ls' },
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(
  env: Record<string, string>,
  stdin = PAYLOAD,
  args: string[] = [],
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(HOOK, args, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    // The hook may exit before reading stdin (no token); ignore the resulting EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

function startServer(received: Received[]): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function freePort(): Promise<number> {
  const server = await startServer([]);
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let home: string;
let cboardHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c-board-hook-'));
  cboardHome = join(home, 'board');
  mkdirSync(cboardHome);
  writeFileSync(join(cboardHome, 'token'), `${TOKEN}\n`, { mode: 0o600 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('c-board-hook', () => {
  it('posts the stdin payload with the token and Claude pid headers', async () => {
    const received: Received[] = [];
    const server = await startServer(received);
    const { port } = server.address() as AddressInfo;
    try {
      const result = await runHook({ CBOARD_HOME: cboardHome, CBOARD_PORT: String(port) });
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(received).toHaveLength(1);
      const [req] = received;
      expect(req?.method).toBe('POST');
      expect(req?.url).toBe('/api/hooks/claude');
      expect(req?.body).toBe(PAYLOAD);
      expect(req?.headers['content-type']).toBe('application/json');
      expect(req?.headers['x-cboard-token']).toBe(TOKEN);
      // spawn() runs the script directly, so its parent is this test process.
      expect(req?.headers['x-cboard-claude-pid']).toBe(String(process.pid));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('defaults CBOARD_HOME to ~/.c-board and accepts a token without a newline', async () => {
    const defaultHome = join(home, '.c-board');
    mkdirSync(defaultHome);
    writeFileSync(join(defaultHome, 'token'), TOKEN);
    const received: Received[] = [];
    const server = await startServer(received);
    const { port } = server.address() as AddressInfo;
    try {
      const result = await runHook({ CBOARD_PORT: String(port) });
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(received[0]?.headers['x-cboard-token']).toBe(TOKEN);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps the token out of the curl command line', () => {
    const script = readFileSync(HOOK, 'utf8');
    const curlCall = script.slice(script.indexOf('curl -q'), script.indexOf('3<<HEADERS'));
    expect(curlCall).not.toContain('$token');
  });

  it('exits 0 silently within about a second when the server is down', async () => {
    const port = await freePort();
    const result = await runHook({ CBOARD_HOME: cboardHome, CBOARD_PORT: String(port) });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    // Generous bound: process startup alone can take ~1 s on a loaded machine or CI runner.
    expect(result.ms).toBeLessThan(3000);
  });

  it('exits 0 silently within about a second when the server hangs', async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await runHook({ CBOARD_HOME: cboardHome, CBOARD_PORT: String(port) });
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(result.ms).toBeLessThan(3000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('exits 0 without a request when the token file is missing', async () => {
    rmSync(join(cboardHome, 'token'));
    const received: Received[] = [];
    const server = await startServer(received);
    const { port } = server.address() as AddressInfo;
    try {
      const result = await runHook({ CBOARD_HOME: cboardHome, CBOARD_PORT: String(port) });
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(received).toHaveLength(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each([
    ['a malformed token', { token: 'bad token\r\nX-Injected: 1' }],
    ['a non-numeric port', { port: '4317; echo pwned' }],
  ])('exits 0 without a request on %s', async (_label, opts: { token?: string; port?: string }) => {
    if (opts.token) writeFileSync(join(cboardHome, 'token'), opts.token);
    const received: Received[] = [];
    const server = await startServer(received);
    const { port } = server.address() as AddressInfo;
    try {
      const result = await runHook({
        CBOARD_HOME: cboardHome,
        CBOARD_PORT: opts.port ?? String(port),
      });
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(received).toHaveLength(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('is valid POSIX sh', () => {
    expect(spawnSync('sh', ['-n', HOOK]).status).toBe(0);
  });

  const shellcheck = spawnSync('shellcheck', ['--version']).status === 0;
  it.skipIf(!shellcheck)('passes shellcheck', () => {
    const result = spawnSync('shellcheck', ['-s', 'sh', HOOK], { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});

const PERMISSION_PAYLOAD = JSON.stringify({
  session_id: '0f3c2a9e-5b7d-4c1e-9a8f-2d6b4e1c7a35',
  hook_event_name: 'PermissionRequest',
  cwd: '/home/dev/acme-shop',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf node_modules' },
});
const DECISION = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' },
  },
});

interface BoardBehaviour {
  /** Body for `GET /api/away`. */
  away: string;
  /** Answers `POST /api/hooks/permission`; null leaves the request hanging. */
  decide: ((res: ServerResponse) => void) | null;
}

function startBoard(received: Received[], behaviour: BoardBehaviour): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/api/away') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(behaviour.away);
      } else if (req.url === '/api/hooks/permission') {
        behaviour.decide?.(res);
      } else res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withBoard(
  behaviour: BoardBehaviour,
  run: (port: number, received: Received[]) => Promise<void>,
): Promise<void> {
  const received: Received[] = [];
  const server = await startBoard(received, behaviour);
  try {
    await run((server.address() as AddressInfo).port, received);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const runPermission = (port: number) =>
  runHook({ CBOARD_HOME: cboardHome, CBOARD_PORT: String(port) }, PERMISSION_PAYLOAD, [
    '--permission',
  ]);

describe('c-board-hook --permission', () => {
  it('exits at once without output or a POST when away mode is off', async () => {
    await withBoard(
      { away: '{"away":false,"timeoutSec":120}', decide: (res) => res.end(DECISION) },
      async (port, received) => {
        const result = await runPermission(port);
        expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
        expect(received.map((r) => r.url)).toEqual(['/api/away']);
        expect(received[0]?.headers['x-cboard-token']).toBe(TOKEN);
        expect(result.ms).toBeLessThan(3000);
      },
    );
  });

  it('exits without output when the board is down', async () => {
    const result = await runPermission(await freePort());
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('posts the request and prints the decision when away mode is on', async () => {
    await withBoard(
      {
        away: '{"away":true,"timeoutSec":120}',
        decide: (res) => {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' }).end(DECISION);
          }, 300);
        },
      },
      async (port, received) => {
        const result = await runPermission(port);
        expect(result).toMatchObject({ code: 0, stderr: '' });
        expect(JSON.parse(result.stdout)).toEqual(JSON.parse(DECISION));
        expect(received.map((r) => r.url)).toEqual(['/api/away', '/api/hooks/permission']);
        const post = received[1];
        expect(post?.method).toBe('POST');
        expect(post?.body).toBe(PERMISSION_PAYLOAD);
        expect(post?.headers['x-cboard-token']).toBe(TOKEN);
        expect(post?.headers['x-cboard-claude-pid']).toBe(String(process.pid));
      },
    );
  });

  it('prints nothing when the board has no decision (204)', async () => {
    await withBoard(
      { away: '{"away":true,"timeoutSec":120}', decide: (res) => res.writeHead(204).end() },
      async (port) => {
        expect(await runPermission(port)).toMatchObject({ code: 0, stdout: '', stderr: '' });
      },
    );
  });

  it('prints nothing for an error or a body that is not a decision', async () => {
    for (const decide of [
      (res: ServerResponse) => res.writeHead(500).end(DECISION),
      (res: ServerResponse) => res.writeHead(200).end('{"ok":true}'),
    ]) {
      await withBoard({ away: '{"away":true,"timeoutSec":120}', decide }, async (port) => {
        expect(await runPermission(port)).toMatchObject({ code: 0, stdout: '', stderr: '' });
      });
    }
  });

  it('gives up silently after the board timeout plus a little slack', async () => {
    await withBoard({ away: '{"away":true,"timeoutSec":0}', decide: null }, async (port) => {
      const result = await runPermission(port);
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
      // timeoutSec 0 → curl waits 5 s.
      expect(result.ms).toBeGreaterThan(4500);
      expect(result.ms).toBeLessThan(9000);
    });
  }, 15_000);
});

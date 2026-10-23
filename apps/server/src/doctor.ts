import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { claudeSettingsPath, HOOK_MARKER } from '@c-board/hook';
import { HealthResponse, ServerStatus } from '@c-board/protocol';
import type { ServerConfig } from './config.js';
import { TOKEN_HEADER } from './security.js';
import { isValidToken, tokenPath } from './token.js';

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: 'node' | 'server' | 'token' | 'hooks' | 'extensions' | 'claude' | 'api-key';
  label: string;
  level: CheckLevel;
  message: string;
  /** What to do about a warning or failure. */
  hint?: string;
}

export interface JsonResponse {
  status: number;
  /** Undefined when the body is not JSON. */
  body: unknown;
}

export interface FileInfo {
  mode: number;
  isFile: boolean;
}

/** Everything the doctor touches outside its own logic, so tests can swap it. */
export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** Whether `host:port` can be bound right now. */
  isPortFree(host: string, port: number): Promise<boolean>;
  /** GET a JSON body, or undefined when nothing answers. */
  getJson(url: string, headers?: Record<string, string>): Promise<JsonResponse | undefined>;
  readText(path: string): Promise<string | undefined>;
  fileInfo(path: string): Promise<FileInfo | undefined>;
  isExecutable(path: string): Promise<boolean>;
  /** Runs `file args…` and returns stdout, or undefined on failure. */
  run(file: string, args: string[]): Promise<string | undefined>;
}

export const MIN_NODE = [22, 5] as const;
const HTTP_TIMEOUT_MS = 1_500;

export function defaultDoctorDeps(home: string, env: NodeJS.ProcessEnv = process.env): DoctorDeps {
  return {
    env,
    home,
    nodeVersion: process.version,
    platform: process.platform,
    isPortFree: (host, port) =>
      new Promise((done) => {
        const probe = createServer();
        probe.once('error', () => done(false));
        probe.listen({ host, port, exclusive: true }, () => probe.close(() => done(true)));
      }),
    getJson: async (url, headers) => {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        return { status: res.status, body: await res.json().catch(() => undefined) };
      } catch {
        return undefined;
      }
    },
    readText: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    fileInfo: async (path) => {
      try {
        const info = await stat(path);
        return { mode: info.mode, isFile: info.isFile() };
      } catch {
        return undefined;
      }
    },
    isExecutable: async (path) => {
      try {
        await access(path, constants.X_OK);
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    run: (file, args) =>
      new Promise((done) => {
        execFile(file, args, { timeout: 5_000, windowsHide: true }, (err, stdout) =>
          done(err ? undefined : stdout),
        );
      }),
  };
}

/** Shortens `<home>/x` to `~/x` so reports don't spell out the home directory. */
export function tildify(path: string, home: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

function parseVersion(raw: string): number[] {
  return (raw.match(/\d+(\.\d+)*/)?.[0] ?? '').split('.').map(Number);
}

function checkNode(deps: DoctorDeps): DoctorCheck {
  const [major = 0, minor = 0] = parseVersion(deps.nodeVersion);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    id: 'node',
    label: 'Node.js',
    level: ok ? 'ok' : 'fail',
    message: ok ? deps.nodeVersion : `${deps.nodeVersion} is too old`,
    ...(ok ? {} : { hint: `c-board needs Node ${MIN_NODE.join('.')} or newer (node:sqlite).` }),
  };
}

async function checkToken(config: ServerConfig, deps: DoctorDeps) {
  const path = tokenPath(config.home);
  const shown = tildify(path, deps.home);
  const info = await deps.fileInfo(path);
  const label = 'Token';
  if (!info) {
    return {
      token: undefined,
      check: {
        id: 'token',
        label,
        level: 'warn',
        message: `${shown} is missing`,
        hint: 'It is created on the next `c-board start`.',
      } satisfies DoctorCheck,
    };
  }
  const token = (await deps.readText(path))?.trim();
  if (!info.isFile || token === undefined || !isValidToken(token)) {
    return {
      token: undefined,
      check: {
        id: 'token',
        label,
        level: 'warn',
        message: `${shown} is not a valid token`,
        hint: 'Run `c-board token --rotate` to replace it.',
      } satisfies DoctorCheck,
    };
  }
  if (deps.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    return {
      token,
      check: {
        id: 'token',
        label,
        level: 'warn',
        message: `${shown} is readable by other users (mode ${(info.mode & 0o777).toString(8)})`,
        hint: `Run \`chmod 600 ${shown}\`, or restart c-board to fix it.`,
      } satisfies DoctorCheck,
    };
  }
  return {
    token,
    check: { id: 'token', label, level: 'ok', message: `${shown} (0600)` } satisfies DoctorCheck,
  };
}

type ServerProbe = { state: 'free' } | { state: 'board'; version: string } | { state: 'foreign' };

async function probeServer(config: ServerConfig, deps: DoctorDeps): Promise<ServerProbe> {
  if (await deps.isPortFree(config.host, config.port)) return { state: 'free' };
  const res = await deps.getJson(`${baseUrl(config)}/api/health`);
  const health = HealthResponse.safeParse(res?.body);
  return health.success ? { state: 'board', version: health.data.version } : { state: 'foreign' };
}

export function baseUrl(config: Pick<ServerConfig, 'host' | 'port'>): string {
  const host =
    config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}`;
}

function checkServer(
  config: ServerConfig,
  probe: ServerProbe,
  status: ServerStatus | undefined,
): DoctorCheck {
  const where = `${config.host}:${config.port}`;
  switch (probe.state) {
    case 'free':
      return {
        id: 'server',
        label: 'Server',
        level: 'ok',
        message: `not running (port ${config.port} is free); start it with \`c-board start\``,
      };
    case 'board': {
      const message = `c-board ${probe.version} is running on ${where}${status?.demo ? ' (demo mode)' : ''}`;
      const live = status?.boardSessions ?? 0;
      // Under `pnpm dev` any edit restarts the server, and its board sessions with it.
      if (status?.watched && live > 0) {
        return {
          id: 'server',
          label: 'Server',
          level: 'warn',
          message: `${message} under a file watcher, with ${live} board session${live === 1 ? '' : 's'} running`,
          hint: 'An edit restarts it and interrupts them. Run `pnpm board` for a board that stays up.',
        };
      }
      return { id: 'server', label: 'Server', level: 'ok', message };
    }
    case 'foreign':
      return {
        id: 'server',
        label: 'Server',
        level: 'fail',
        message: `port ${config.port} is used by another program`,
        hint: 'Stop it, or pick another port with CBOARD_PORT.',
      };
  }
}

async function fetchStatus(
  config: ServerConfig,
  deps: DoctorDeps,
  token: string | undefined,
): Promise<ServerStatus | 'unauthorized' | undefined> {
  if (token === undefined) return 'unauthorized';
  const res = await deps.getJson(`${baseUrl(config)}/api/status`, { [TOKEN_HEADER]: token });
  if (res?.status === 401) return 'unauthorized';
  const status = ServerStatus.safeParse(res?.body);
  return status.success ? status.data : undefined;
}

export { claudeSettingsPath };

/** Hook events whose handlers run the c-board hook script. */
export function installedHookEvents(settings: unknown): string[] {
  if (typeof settings !== 'object' || settings === null) return [];
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== 'object' || hooks === null) return [];
  const events: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const found = groups.some(
      (group) =>
        typeof group === 'object' &&
        group !== null &&
        Array.isArray((group as { hooks?: unknown }).hooks) &&
        (group as { hooks: unknown[] }).hooks.some(
          (hook) =>
            typeof hook === 'object' &&
            hook !== null &&
            typeof (hook as { command?: unknown }).command === 'string' &&
            (hook as { command: string }).command.includes(HOOK_MARKER),
        ),
    );
    if (found) events.push(event);
  }
  return events;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

async function checkHooks(
  deps: DoctorDeps,
  status: ServerStatus | undefined,
  now: number,
): Promise<DoctorCheck> {
  const path = claudeSettingsPath(deps.env, deps.home);
  const shown = tildify(path, deps.home);
  const raw = await deps.readText(path);
  const notInstalled = (message: string): DoctorCheck => ({
    id: 'hooks',
    label: 'Claude hooks',
    level: 'warn',
    message,
    hint: 'Run `c-board hooks install` so Claude sessions show up on the board.',
  });
  if (raw === undefined) return notInstalled(`${shown} not found`);

  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return {
      id: 'hooks',
      label: 'Claude hooks',
      level: 'warn',
      message: `${shown} is not valid JSON`,
      hint: 'Fix the file; the hook installer refuses to edit invalid JSON.',
    };
  }
  const events = installedHookEvents(settings);
  if (events.length === 0) return notInstalled(`not installed in ${shown}`);

  let received = '';
  if (status) {
    received =
      status.hooks.received === 0 || status.hooks.lastAt === null
        ? '; no events received yet'
        : `; ${status.hooks.received} received, last ${ago(now - status.hooks.lastAt)}`;
  }
  return {
    id: 'hooks',
    label: 'Claude hooks',
    level: 'ok',
    message: `${events.length} event${events.length === 1 ? '' : 's'} in ${shown}${received}`,
  };
}

function checkExtensions(
  probe: ServerProbe,
  status: ServerStatus | 'unauthorized' | undefined,
): DoctorCheck {
  const base = { id: 'extensions', label: 'Editor extension' } as const;
  if (probe.state !== 'board') {
    return { ...base, level: 'skip', message: 'server not running' };
  }
  if (status === 'unauthorized') {
    return {
      ...base,
      level: 'warn',
      message: 'the running server rejected the token',
      hint: 'Restart c-board after rotating the token.',
    };
  }
  if (status === undefined) {
    return { ...base, level: 'warn', message: 'could not read the server status' };
  }
  if (status.editors === 0) {
    return {
      ...base,
      level: 'warn',
      message: 'no Cursor or VS Code window connected',
      hint: 'Install the c-board extension and open a window.',
    };
  }
  return {
    ...base,
    level: 'ok',
    message: `${status.editors} window${status.editors === 1 ? '' : 's'} connected`,
  };
}

async function findOnPath(deps: DoctorDeps, name: string): Promise<string | undefined> {
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

async function checkClaude(deps: DoctorDeps): Promise<DoctorCheck> {
  const base = { id: 'claude', label: 'Claude Code' } as const;
  const bin = await findOnPath(deps, 'claude');
  if (bin === undefined) {
    return {
      ...base,
      level: 'warn',
      message: '`claude` is not on PATH',
      hint: 'Install Claude Code to start and resume sessions from the board.',
    };
  }
  const output = (await deps.run(bin, ['--version']))?.trim();
  if (!output) {
    return {
      ...base,
      level: 'warn',
      message: '`claude --version` failed',
      hint: 'Check that Claude Code runs in a terminal.',
    };
  }
  return { ...base, level: 'ok', message: output.split('\n', 1)[0] ?? output };
}

function checkApiKey(deps: DoctorDeps): DoctorCheck {
  const base = { id: 'api-key', label: 'Billing' } as const;
  if (deps.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      ...base,
      level: 'warn',
      message: 'ANTHROPIC_API_KEY is set',
      hint: 'Sessions started from the board bill that key instead of your Claude login. Unset it to use your subscription.',
    };
  }
  return { ...base, level: 'ok', message: 'uses your Claude Code login' };
}

export async function runDoctor(
  config: ServerConfig,
  deps: DoctorDeps,
  now: number = Date.now(),
): Promise<DoctorCheck[]> {
  const [probe, tokenResult] = await Promise.all([
    probeServer(config, deps),
    checkToken(config, deps),
  ]);
  const status =
    probe.state === 'board' ? await fetchStatus(config, deps, tokenResult.token) : undefined;
  const liveStatus = typeof status === 'object' ? status : undefined;
  const [hooks, claude] = await Promise.all([checkHooks(deps, liveStatus, now), checkClaude(deps)]);
  return [
    checkNode(deps),
    checkServer(config, probe, liveStatus),
    tokenResult.check,
    hooks,
    checkExtensions(probe, status),
    claude,
    checkApiKey(deps),
  ];
}

const SYMBOLS: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
const COLORS: Record<CheckLevel, string> = { ok: '32', warn: '33', fail: '31', skip: '90' };

export function formatDoctorReport(
  checks: readonly DoctorCheck[],
  options: { version: string; color: boolean },
): string {
  const paint = (code: string, text: string) =>
    options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const width = Math.max(...checks.map((check) => check.label.length));
  const lines = [`${paint('1', 'c-board doctor')} ${paint('90', `v${options.version}`)}`, ''];
  for (const check of checks) {
    const symbol = paint(COLORS[check.level], SYMBOLS[check.level]);
    lines.push(`  ${symbol} ${check.label.padEnd(width)}  ${check.message}`);
    if (check.hint && check.level !== 'ok') {
      lines.push(`  ${' '.repeat(width + 4)}${paint('90', check.hint)}`);
    }
  }
  const count = (level: CheckLevel) => checks.filter((check) => check.level === level).length;
  const warnings = count('warn');
  const failures = count('fail');
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  lines.push(
    '',
    `${plural(count('ok'), 'check')} passed, ${plural(warnings, 'warning')}, ${plural(failures, 'failure')}`,
  );
  return `${lines.join('\n')}\n`;
}

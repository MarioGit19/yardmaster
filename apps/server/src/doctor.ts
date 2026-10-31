import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  claudeSettingsPath,
  InvalidSettingsError,
  isHookCommand,
  statuslineStatus,
} from '@yardmaster/hook';
import { HealthResponse, LOCAL_SOCKET_FILE, ServerStatus } from '@yardmaster/protocol';
import type { ServerConfig } from './config.js';
import { DB_FILE } from './data-dir.js';
import { findEditorCli, findOnPath } from './editor-cli.js';
import { loadNodePty } from './pty.js';
import { TOKEN_HEADER } from './security.js';
import { isValidToken, tokenPath } from './token.js';

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id:
    | 'node'
    | 'server'
    | 'token'
    | 'data'
    | 'channel'
    | 'hooks'
    | 'statusline'
    | 'extensions'
    | 'editor-cli'
    | 'pty'
    | 'claude'
    | 'api-key';
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

export interface SocketInfo {
  isSocket: boolean;
  /** Owned by the user running doctor. */
  ours: boolean;
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
  /** GET a JSON body over a Unix socket, or undefined when nothing answers. */
  getLocalJson(
    socketPath: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<JsonResponse | undefined>;
  /** `lstat` of a path that should be the board's socket. */
  socketInfo(path: string): Promise<SocketInfo | undefined>;
  readText(path: string): Promise<string | undefined>;
  fileInfo(path: string): Promise<FileInfo | undefined>;
  isExecutable(path: string): Promise<boolean>;
  /** Runs `file args…` and returns stdout, or undefined on failure. */
  run(file: string, args: string[]): Promise<string | undefined>;
  /** Whether node-pty (board terminals) loads here, and why not. */
  loadPty(): Promise<{ ok: true } | { ok: false; reason: string }>;
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
    getLocalJson: (socketPath, path, headers) =>
      new Promise((done) => {
        const req = request({ socketPath, path, headers, timeout: HTTP_TIMEOUT_MS }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => {
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            done({ status: res.statusCode ?? 0, body });
          });
          res.on('error', () => done(undefined));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => done(undefined));
        req.end();
      }),
    socketInfo: async (path) => {
      try {
        const info = await lstat(path);
        const uid = process.getuid?.();
        return { isSocket: info.isSocket(), ours: uid === undefined || info.uid === uid };
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
    loadPty: loadNodePty,
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
    ...(ok ? {} : { hint: `Yardmaster needs Node ${MIN_NODE.join('.')} or newer (node:sqlite).` }),
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
        hint: 'It is created on the next `yardmaster start`.',
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
        hint: 'Run `yardmaster token --rotate` to replace it.',
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
        hint: `Run \`chmod 600 ${shown}\`, or restart Yardmaster to fix it.`,
      } satisfies DoctorCheck,
    };
  }
  return {
    token,
    check: { id: 'token', label, level: 'ok', message: `${shown} (0600)` } satisfies DoctorCheck,
  };
}

const modeOf = (info: FileInfo) => (info.mode & 0o777).toString(8).padStart(4, '0');

/** The data dir is 0700 and `board.db` 0600: they hold terminal output and transcripts. */
async function checkDataDir(config: ServerConfig, deps: DoctorDeps): Promise<DoctorCheck> {
  const base = { id: 'data', label: 'Data dir' } as const;
  const dirShown = tildify(config.home, deps.home);
  const dbPath = join(config.home, DB_FILE);
  const [dir, db] = await Promise.all([deps.fileInfo(config.home), deps.fileInfo(dbPath)]);
  if (!dir) {
    return {
      ...base,
      level: 'warn',
      message: `${dirShown} is missing`,
      hint: 'It is created on the next `yardmaster start`.',
    };
  }
  const posix = deps.platform !== 'win32';
  const loose: string[] = [];
  if (posix && (dir.mode & 0o077) !== 0) loose.push(`${dirShown} (mode ${modeOf(dir)})`);
  if (posix && db && (db.mode & 0o077) !== 0) loose.push(`${DB_FILE} (mode ${modeOf(db)})`);
  if (loose.length > 0) {
    return {
      ...base,
      level: 'warn',
      message: `readable by other users: ${loose.join(', ')}`,
      hint: `Restart Yardmaster to fix it, or run \`chmod 700 ${dirShown}\` and \`chmod 600 ${tildify(dbPath, deps.home)}\`.`,
    };
  }
  const dbPart = db ? `${DB_FILE} (${modeOf(db)})` : `no ${DB_FILE} yet`;
  return { ...base, level: 'ok', message: `${dirShown} (${modeOf(dir)}), ${dbPart}` };
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
        message: `not running (port ${config.port} is free); start it with \`yardmaster start\``,
      };
    case 'board': {
      const message = `Yardmaster ${probe.version} is running on ${where}${status?.demo ? ' (demo mode)' : ''}`;
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
        hint: 'Stop it, or pick another port with YARDMASTER_PORT.',
      };
  }
}

/** Asks over the socket, so the token never goes to whatever holds the TCP port. */
async function fetchStatus(
  config: ServerConfig,
  deps: DoctorDeps,
  token: string | undefined,
): Promise<ServerStatus | 'unauthorized' | undefined> {
  if (token === undefined) return 'unauthorized';
  const res = await deps.getLocalJson(localSocket(config), '/api/status', {
    [TOKEN_HEADER]: token,
  });
  if (res?.status === 401) return 'unauthorized';
  const status = ServerStatus.safeParse(res?.body);
  return status.success ? status.data : undefined;
}

export { claudeSettingsPath };

function localSocket(config: ServerConfig): string {
  return join(config.home, LOCAL_SOCKET_FILE);
}

/** The socket editors and hooks use (PRD §8 item 13): there, private, and answering. */
async function checkChannel(
  config: ServerConfig,
  deps: DoctorDeps,
  probe: ServerProbe,
): Promise<DoctorCheck> {
  const base = { id: 'channel', label: 'Local socket' } as const;
  const path = localSocket(config);
  const shown = tildify(path, deps.home);
  const info = await deps.socketInfo(path);
  if (!info) {
    return probe.state === 'board'
      ? {
          ...base,
          level: 'fail',
          message: `the running server does not listen on ${shown}`,
          hint: 'Editors and Claude hooks connect only there. Restart Yardmaster and check its log, or update it if it is older.',
        }
      : { ...base, level: 'skip', message: 'server not running' };
  }
  if (!info.isSocket || !info.ours) {
    return {
      ...base,
      level: 'fail',
      message: `${shown} is not a socket of yours`,
      hint: `Yardmaster won't replace it. Stop Yardmaster, remove ${shown} and start it again.`,
    };
  }
  const dir = await deps.fileInfo(config.home);
  if (deps.platform !== 'win32' && dir && (dir.mode & 0o077) !== 0) {
    return {
      ...base,
      level: 'warn',
      message: `${tildify(config.home, deps.home)} is open to other users (mode ${(dir.mode & 0o777).toString(8)})`,
      hint: 'Restart Yardmaster to make it private (0700).',
    };
  }
  const health = HealthResponse.safeParse((await deps.getLocalJson(path, '/api/health'))?.body);
  if (!health.success) {
    return probe.state === 'board'
      ? {
          ...base,
          level: 'fail',
          message: `nothing answers on ${shown}`,
          hint: 'Restart Yardmaster.',
        }
      : { ...base, level: 'skip', message: `server not running (${shown} is left over)` };
  }
  return { ...base, level: 'ok', message: `${shown} (owner only)` };
}

/** Hook events whose handlers run the Yardmaster hook script. */
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
            isHookCommand((hook as { command: string }).command),
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
    hint: 'Run `yardmaster hooks install` so Claude sessions show up on the board.',
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

/** The optional usage forwarder: not installing it only hides the usage chip. */
async function checkStatusline(
  deps: DoctorDeps,
  status: ServerStatus | undefined,
  now: number,
): Promise<DoctorCheck> {
  const base = { id: 'statusline', label: 'Statusline' } as const;
  let installed: ReturnType<typeof statuslineStatus>;
  try {
    installed = statuslineStatus(await deps.readText(claudeSettingsPath(deps.env, deps.home)));
  } catch (err) {
    if (!(err instanceof InvalidSettingsError)) throw err;
    return { ...base, level: 'skip', message: `not checked: settings ${err.message}` };
  }
  if (installed.state === 'missing') {
    return {
      ...base,
      level: 'skip',
      message: 'forwarder not installed (optional)',
      hint: 'Run `yardmaster statusline install` for the usage chip. Your statusline stays as it is.',
    };
  }
  if (installed.state === 'outdated') {
    return {
      ...base,
      level: 'warn',
      message: 'the forwarder points at another Yardmaster install',
      hint: 'Run `yardmaster statusline install` to update it.',
    };
  }
  const wrapped =
    installed.previous === null ? 'no statusline of your own' : 'runs your statusline';
  const last = status?.statusline?.lastAt;
  const heard = !status
    ? ''
    : last == null
      ? '; nothing received yet'
      : `; last ${ago(now - last)}`;
  return { ...base, level: 'ok', message: `forwarder installed, ${wrapped}${heard}` };
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
      hint: 'Restart Yardmaster after rotating the token.',
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
      hint: 'Install the Yardmaster extension and open a window.',
    };
  }
  return {
    ...base,
    level: 'ok',
    message: `${status.editors} window${status.editors === 1 ? '' : 's'} connected`,
  };
}

/**
 * The CLI "Open in Cursor" runs: what the running server found (it knows the path set in
 * Settings), else the default lookup of `cursor`, then `code`.
 */
async function checkEditorCli(
  deps: DoctorDeps,
  status: ServerStatus | undefined,
): Promise<DoctorCheck> {
  const base = { id: 'editor-cli', label: 'Editor CLI' } as const;
  const cli = status?.editorCli !== undefined ? status.editorCli : await findEditorCli(deps);
  if (cli === null) {
    return {
      ...base,
      level: 'warn',
      message: 'neither `cursor` nor `code` was found',
      hint: 'To open projects from the board, run "Shell Command: Install \'cursor\' command" in Cursor, or set the CLI path in Settings → Projects.',
    };
  }
  const where = tildify(cli.path, deps.home);
  return {
    ...base,
    level: 'ok',
    message: `${cli.app} at ${where}${cli.configured ? ' (set in Settings)' : ''}`,
  };
}

/** node-pty, behind board terminals (F19): the running server's answer, else a load here. */
async function checkPty(deps: DoctorDeps, status: ServerStatus | undefined): Promise<DoctorCheck> {
  const base = { id: 'pty', label: 'Board terminals' } as const;
  const board = status?.boardTerminals;
  const loaded = board
    ? board.available
      ? { ok: true as const }
      : { ok: false as const, reason: board.reason ?? 'node-pty did not load' }
    : await deps.loadPty();
  if (!loaded.ok) {
    return {
      ...base,
      level: 'warn',
      message: loaded.reason,
      hint: 'New terminals need an editor window until node-pty loads. Reinstall Yardmaster (node-pty ships prebuilt binaries; other platforms build it with node-gyp).',
    };
  }
  const live = board ? `; ${board.live} of ${board.max} running` : '';
  return { ...base, level: 'ok', message: `node-pty loads${live}` };
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
      hint: "Sessions started from the board bill that key instead of going through your signed-in Claude Code. Unset it to use Claude Code's own sign-in.",
    };
  }
  return { ...base, level: 'ok', message: 'uses your Claude Code login' };
}

export async function runDoctor(
  config: ServerConfig,
  deps: DoctorDeps,
  now: number = Date.now(),
): Promise<DoctorCheck[]> {
  const [probe, tokenResult, data] = await Promise.all([
    probeServer(config, deps),
    checkToken(config, deps),
    checkDataDir(config, deps),
  ]);
  const status =
    probe.state === 'board' ? await fetchStatus(config, deps, tokenResult.token) : undefined;
  const liveStatus = typeof status === 'object' ? status : undefined;
  const [channel, hooks, statusline, editorCli, pty, claude] = await Promise.all([
    checkChannel(config, deps, probe),
    checkHooks(deps, liveStatus, now),
    checkStatusline(deps, liveStatus, now),
    checkEditorCli(deps, liveStatus),
    checkPty(deps, liveStatus),
    checkClaude(deps),
  ]);
  return [
    checkNode(deps),
    checkServer(config, probe, liveStatus),
    tokenResult.check,
    data,
    channel,
    hooks,
    statusline,
    checkExtensions(probe, status),
    editorCli,
    pty,
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
  const lines = [`${paint('1', 'yardmaster doctor')} ${paint('90', `v${options.version}`)}`, ''];
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

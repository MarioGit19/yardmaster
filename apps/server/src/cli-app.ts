import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import {
  applyPlan,
  awayHookStatus,
  claudeSettingsPath,
  hookStatus,
  InvalidSettingsError,
  OBSERVER_EVENTS,
  planInstall,
  planUninstall,
  readSettings,
  unifiedDiff,
} from '@c-board/hook';
import type { FastifyInstance } from 'fastify';
import type { BuildOptions } from './app.js';
import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import {
  baseUrl,
  type DoctorDeps,
  defaultDoctorDeps,
  formatDoctorReport,
  runDoctor,
  tildify,
} from './doctor.js';
import { openBrowser } from './open-browser.js';
import { DEFAULT_WEB_ROOT, hasWebBuild } from './static.js';
import { ensureToken, generateToken, tokenPath, writeToken } from './token.js';
import { VERSION } from './version.js';

export interface CliIo {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
  home: string;
  /** Swappable for tests. */
  startServer?: (config: ServerConfig, options: BuildOptions) => Promise<FastifyInstance>;
  openBrowser?: (url: string) => Promise<boolean>;
  doctorDeps?: (config: ServerConfig) => DoctorDeps;
  /** Called once a started server is listening, e.g. to install signal handlers. */
  onStarted?: (app: FastifyInstance) => void;
  /** Asks a yes/no question. Absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
}

export const USAGE = `Usage: c-board <command> [options]

Commands:
  start [--demo] [--no-open]   Start the board and open it in your browser
  doctor                       Check the setup and print a report
  token --rotate               Replace the install token (signs out every browser)
  hooks install|uninstall|status [--away] [--dry-run] [--yes] [--settings-path <file>]
                               Manage the c-board hooks in Claude's settings.json.
                               --away also installs the away-mode permission hook

Options:
  -h, --help                   Show this help
  -v, --version                Print the version

Environment: CBOARD_PORT (4317), CBOARD_HOME (~/.c-board), CBOARD_HOST (127.0.0.1),
  CLAUDE_CONFIG_DIR (~/.claude)
`;

class UsageError extends Error {}

function parse<T extends ParseArgsOptionsConfig>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function useColor(io: CliIo): boolean {
  return Boolean(io.stdout.isTTY) && !io.env.NO_COLOR && io.env.TERM !== 'dumb';
}

function listeningPort(app: FastifyInstance, fallback: number): number {
  const address = app.server.address();
  return address !== null && typeof address === 'object' ? address.port : fallback;
}

async function start(args: string[], config: ServerConfig, io: CliIo): Promise<number | null> {
  const flags = parse(args, { demo: { type: 'boolean' }, 'no-open': { type: 'boolean' } });
  const token = await ensureToken(config.home);
  const webRoot = DEFAULT_WEB_ROOT;
  let app: FastifyInstance;
  try {
    // Loaded lazily so `doctor` and `token` don't pull in node:sqlite.
    const launch = io.startServer ?? (await import('./app.js')).startServer;
    app = await launch(config, {
      token,
      demo: flags.demo ?? false,
      webRoot,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    io.stderr.write(
      `c-board: port ${config.port} is already in use. Is c-board running? Try \`c-board doctor\`.\n`,
    );
    return 1;
  }
  io.onStarted?.(app);

  const url = baseUrl({ host: config.host, port: listeningPort(app, config.port) });
  const authUrl = `${url}/auth?t=${encodeURIComponent(token)}`;
  if (flags.demo) app.log.info('demo mode: serving synthetic projects, nothing is persisted');
  if (!hasWebBuild(webRoot)) {
    io.stdout.write('The web app is not built yet; run `pnpm --filter @c-board/web build`.\n');
  }

  const opened = !flags['no-open'] && (await (io.openBrowser ?? openBrowser)(authUrl));
  if (opened) {
    io.stdout.write(`c-board is running at ${url} (opened in your browser)\n`);
  } else {
    io.stdout.write(`c-board is running at ${url}\nSign in with: ${authUrl}\n`);
  }
  return null;
}

async function doctor(args: string[], config: ServerConfig, io: CliIo): Promise<number> {
  parse(args, {});
  const deps = (io.doctorDeps ?? (() => defaultDoctorDeps(io.home, io.env)))(config);
  const checks = await runDoctor(config, deps);
  io.stdout.write(formatDoctorReport(checks, { version: VERSION, color: useColor(io) }));
  return checks.some((check) => check.level === 'fail') ? 1 : 0;
}

async function token(args: string[], config: ServerConfig, io: CliIo): Promise<number> {
  const flags = parse(args, { rotate: { type: 'boolean' } });
  const shown = tildify(tokenPath(config.home), io.home);
  if (!flags.rotate) {
    io.stderr.write(`The token lives in ${shown}. Use \`c-board token --rotate\` to replace it.\n`);
    return 2;
  }
  await writeToken(config.home, generateToken());
  io.stdout.write(
    `New token written to ${shown}. Restart c-board and sign in again with \`c-board start\`.\n`,
  );
  return 0;
}

const HOOK_ACTIONS = ['install', 'uninstall', 'status'] as const;

async function hooks(args: string[], _config: ServerConfig, io: CliIo): Promise<number> {
  const [action, ...rest] = args;
  if (!HOOK_ACTIONS.includes(action as (typeof HOOK_ACTIONS)[number])) {
    throw new UsageError(`expected one of ${HOOK_ACTIONS.join(', ')}`);
  }
  const flags = parse(rest, {
    away: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    'settings-path': { type: 'string' },
  });
  const path = resolve(flags['settings-path'] ?? claudeSettingsPath(io.env, io.home));
  const shown = tildify(path, io.home);

  try {
    const raw = await readSettings(path);
    if (action === 'status') {
      const status = hookStatus(raw);
      const total = OBSERVER_EVENTS.length;
      io.stdout.write(`${status.installed.length}/${total} hook events installed in ${shown}\n`);
      if (status.missing.length > 0) io.stdout.write(`  missing: ${status.missing.join(', ')}\n`);
      if (status.outdated.length > 0) {
        io.stdout.write(`  outdated: ${status.outdated.join(', ')}\n`);
      }
      const away = awayHookStatus(raw);
      io.stdout.write(
        away === 'installed'
          ? 'Away-mode permission hook installed\n'
          : `Away-mode permission hook ${away === 'missing' ? 'not installed' : 'outdated'} (optional: \`c-board hooks install --away\`)\n`,
      );
      if (status.installed.length === total) return 0;
      io.stdout.write('Run `c-board hooks install` to fix this.\n');
      return 1;
    }

    const install = action === 'install';
    if (flags.away && !install) throw new UsageError('--away only applies to install');
    const plan = install
      ? planInstall(raw, undefined, { away: flags.away ?? false })
      : planUninstall(raw);
    if (!plan.changed) {
      io.stdout.write(
        install
          ? `The c-board hooks are already installed in ${shown}. Nothing changed.\n`
          : `No c-board hooks found in ${shown}. Nothing changed.\n`,
      );
      return 0;
    }
    const diff = unifiedDiff(plan.before ?? '', plan.after, shown, shown);
    if (flags['dry-run']) {
      io.stdout.write(`${diff}Dry run: nothing was written.\n`);
      return 0;
    }
    if (!flags.yes) {
      if (!io.confirm) {
        io.stderr.write(`c-board hooks: no terminal to confirm on; pass --yes to edit ${shown}.\n`);
        return 1;
      }
      io.stdout.write(diff);
      if (!(await io.confirm(`Write these changes to ${shown}?`))) {
        io.stdout.write('Nothing was written.\n');
        return 1;
      }
    }
    const backup = await applyPlan(path, plan);
    io.stdout.write(
      install
        ? `Installed the c-board hook for ${OBSERVER_EVENTS.length} events${flags.away ? ' and the away-mode permission hook' : ''} in ${shown}.\n`
        : `Removed the c-board hooks from ${shown}.\n`,
    );
    if (backup) io.stdout.write(`Backup: ${tildify(backup, io.home)}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof InvalidSettingsError)) throw err;
    io.stderr.write(`c-board hooks: ${shown} ${err.message}. Nothing was written.\n`);
    return 1;
  }
}

const COMMANDS = { start, doctor, token, hooks } as const;

/** Runs one CLI invocation. Resolves to an exit code, or null when the server keeps running. */
export async function runCli(argv: string[], io: CliIo): Promise<number | null> {
  const [command = 'start', ...rest] = argv;
  if (command === '-h' || command === '--help' || command === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // `c-board --demo` is shorthand for `c-board start --demo`.
  const [name, args] = command.startsWith('-') ? ['start', argv] : [command, rest];
  if (!Object.hasOwn(COMMANDS, name)) {
    io.stderr.write(`c-board: unknown command "${name}"\n\n${USAGE}`);
    return 2;
  }

  try {
    const config = loadConfig(io.env, io.home);
    return await COMMANDS[name as keyof typeof COMMANDS](args, config, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`c-board ${name}: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof ConfigError) {
      io.stderr.write(`c-board: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function askTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export function processIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    home: homedir(),
    ...(process.stdin.isTTY && process.stdout.isTTY ? { confirm: askTty } : {}),
  };
}

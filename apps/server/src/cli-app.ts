import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
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
} from '@yardmaster/hook';
import type { FastifyInstance } from 'fastify';
import type { BuildOptions } from './app.js';
import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { STRESS_PROJECTS_MAX } from './demo/stress.js';
import {
  baseUrl,
  type DoctorDeps,
  defaultDoctorDeps,
  formatDoctorReport,
  runDoctor,
  tildify,
} from './doctor.js';
import { envValue, LEGACY_COMMAND, LEGACY_NOTICE, legacyHomeFor, migrateHome } from './legacy.js';
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
  /** The name the CLI was run as; the old `c-board` prints a deprecation notice. */
  invokedAs?: string;
}

export const USAGE = `Usage: yardmaster <command> [options]

Commands:
  start [--demo] [--no-open]   Start the board and open it in your browser
        [--demo-stress]        A demo board at the performance target (PRD §9)
        [--demo-projects <n>]  With --demo-stress: how many projects (default 10)
  doctor                       Check the setup and print a report
  token --rotate               Replace the install token (signs out every browser)
  hooks install|uninstall|status [--away] [--dry-run] [--yes] [--settings-path <file>]
                               Manage the Yardmaster hooks in Claude's settings.json.
                               --away also installs the away-mode permission hook
  install-hooks [--away] …     Same as hooks install

Options:
  -h, --help                   Show this help
  -v, --version                Print the version

Environment: YARDMASTER_PORT (4317), YARDMASTER_HOME (~/.yardmaster), YARDMASTER_HOST (127.0.0.1),
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
  const flags = parse(args, {
    demo: { type: 'boolean' },
    'demo-stress': { type: 'boolean' },
    'demo-projects': { type: 'string' },
    'no-open': { type: 'boolean' },
  });
  const projects = flags['demo-projects'];
  if (projects !== undefined) {
    if (!flags['demo-stress'])
      throw new UsageError('--demo-projects only applies to --demo-stress');
    const count = Number(projects);
    if (!Number.isInteger(count) || count < 1 || count > STRESS_PROJECTS_MAX) {
      throw new UsageError(`--demo-projects takes a whole number from 1 to ${STRESS_PROJECTS_MAX}`);
    }
  }
  const demo = flags['demo-stress']
    ? { stress: true, ...(projects !== undefined && { projects: Number(projects) }) }
    : (flags.demo ?? false);
  const token = await ensureToken(config.home);
  const webRoot = DEFAULT_WEB_ROOT;
  let app: FastifyInstance;
  try {
    // Loaded lazily so `doctor` and `token` don't pull in node:sqlite.
    const launch = io.startServer ?? (await import('./app.js')).startServer;
    app = await launch(config, {
      token,
      demo,
      webRoot,
      watched: envValue(io.env, 'WATCH') === '1',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    io.stderr.write(
      `yardmaster: port ${config.port} is already in use. Is Yardmaster running? Try \`yardmaster doctor\`.\n`,
    );
    return 1;
  }
  io.onStarted?.(app);

  const url = baseUrl({ host: config.host, port: listeningPort(app, config.port) });
  const authUrl = `${url}/auth?t=${encodeURIComponent(token)}`;
  if (demo) app.log.info('demo mode: serving synthetic projects, nothing is persisted');
  if (envValue(io.env, 'WATCH') === '1') {
    io.stdout.write(
      'Watching for changes: an edit restarts the server and interrupts board sessions. Use `pnpm board` for a board that stays up.\n',
    );
  }
  const channel = app.localChannel?.state;
  if (channel?.kind === 'unavailable') {
    io.stderr.write(
      `yardmaster: can't listen on ${tildify(channel.path, io.home)} (${channel.reason}), so editors and Claude hooks can't connect. See \`yardmaster doctor\`.\n`,
    );
  }
  if (!hasWebBuild(webRoot)) {
    io.stdout.write('The web app is not built yet; run `pnpm --filter @yardmaster/web build`.\n');
  }

  const opened = !flags['no-open'] && (await (io.openBrowser ?? openBrowser)(authUrl));
  if (opened) {
    io.stdout.write(`Yardmaster is running at ${url} (opened in your browser)\n`);
  } else {
    io.stdout.write(`Yardmaster is running at ${url}\nSign in with: ${authUrl}\n`);
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
    io.stderr.write(
      `The token lives in ${shown}. Use \`yardmaster token --rotate\` to replace it.\n`,
    );
    return 2;
  }
  await writeToken(config.home, generateToken());
  io.stdout.write(
    `New token written to ${shown}. Restart Yardmaster and sign in again with \`yardmaster start\`.\n`,
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
          : `Away-mode permission hook ${away === 'missing' ? 'not installed' : 'outdated'} (optional: \`yardmaster hooks install --away\`)\n`,
      );
      if (status.installed.length === total) return 0;
      io.stdout.write('Run `yardmaster hooks install` to fix this.\n');
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
          ? `The Yardmaster hooks are already installed in ${shown}. Nothing changed.\n`
          : `No Yardmaster hooks found in ${shown}. Nothing changed.\n`,
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
        io.stderr.write(
          `yardmaster hooks: no terminal to confirm on; pass --yes to edit ${shown}.\n`,
        );
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
        ? `Installed the Yardmaster hook for ${OBSERVER_EVENTS.length} events${flags.away ? ' and the away-mode permission hook' : ''} in ${shown}.\n`
        : `Removed the Yardmaster hooks from ${shown}.\n`,
    );
    if (backup) io.stdout.write(`Backup: ${tildify(backup, io.home)}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof InvalidSettingsError)) throw err;
    io.stderr.write(`yardmaster hooks: ${shown} ${err.message}. Nothing was written.\n`);
    return 1;
  }
}

const COMMANDS = {
  start,
  doctor,
  token,
  hooks,
  'install-hooks': (args: string[], config: ServerConfig, io: CliIo) =>
    hooks(['install', ...args], config, io),
} as const;

/** Commands that read the data dir, so they move the old one first. */
const USES_HOME = new Set(['start', 'doctor', 'token']);

async function migrateLegacyHome(config: ServerConfig, io: CliIo): Promise<void> {
  const legacy = legacyHomeFor(io.env, io.home);
  if (legacy === null || resolve(legacy) === resolve(config.home)) return;
  const result = await migrateHome(config.home, legacy);
  const from = result.kind === 'none' ? '' : tildify(result.from, io.home);
  const to = tildify(config.home, io.home);
  if (result.kind === 'moved') {
    io.stdout.write(`Moved your data from ${from} to ${to} (the old path links to it).\n`);
  } else if (result.kind === 'failed') {
    io.stderr.write(`yardmaster: could not move ${from} to ${to}: ${result.error}\n`);
  }
}

/** Runs one CLI invocation. Resolves to an exit code, or null when the server keeps running. */
export async function runCli(argv: string[], io: CliIo): Promise<number | null> {
  if (io.invokedAs === LEGACY_COMMAND) io.stderr.write(LEGACY_NOTICE);
  const [command = 'start', ...rest] = argv;
  if (command === '-h' || command === '--help' || command === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // `yardmaster --demo` is shorthand for `yardmaster start --demo`.
  const [name, args] = command.startsWith('-') ? ['start', argv] : [command, rest];
  if (!Object.hasOwn(COMMANDS, name)) {
    io.stderr.write(`yardmaster: unknown command "${name}"\n\n${USAGE}`);
    return 2;
  }

  try {
    const config = loadConfig(io.env, io.home);
    if (USES_HOME.has(name)) await migrateLegacyHome(config, io);
    return await COMMANDS[name as keyof typeof COMMANDS](args, config, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`yardmaster ${name}: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof ConfigError) {
      io.stderr.write(`yardmaster: ${err.message}\n`);
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
    invokedAs: basename(process.argv[1] ?? '', extname(process.argv[1] ?? '')),
    ...(process.stdin.isTTY && process.stdout.isTTY ? { confirm: askTty } : {}),
  };
}

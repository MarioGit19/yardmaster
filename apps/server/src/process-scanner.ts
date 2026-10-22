import { execFile } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import {
  attributeTerminals,
  bindPorts,
  buildTree,
  type Listener,
  type ProcessTree,
  parseLsof,
  parsePs,
  parseSs,
  sameStats,
} from './processes.js';
import type { BoardStore } from './store.js';

export const PS_INTERVAL_MS = 2_000;
export const PORT_INTERVAL_MS = 5_000;
const COMMAND_TIMEOUT_MS = 4_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

/** Runs a program with an argument array and resolves its stdout. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

export interface ProcessScannerOptions {
  store: BoardStore;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  psIntervalMs?: number;
  portIntervalMs?: number;
  now?: () => number;
}

type PortTool = 'lsof' | 'ss' | null;

/**
 * Samples the process table and listening TCP ports (PRD §6.6), attributes CPU, RSS
 * and ports to terminal subtrees, and writes only what changed into the store.
 */
export class ProcessScanner {
  private readonly store: BoardStore;
  private readonly log: ProcessScannerOptions['logger'];
  private readonly platform: NodeJS.Platform;
  private readonly run: CommandRunner;
  private readonly psIntervalMs: number;
  private readonly portIntervalMs: number;
  private readonly now: () => number;
  private readonly timers: NodeJS.Timeout[] = [];
  private portTool: PortTool;
  private listeners: Listener[] = [];
  private owner = new Map<number, string>();
  private latest: ProcessTree | null = null;
  private psBusy = false;
  private portsBusy = false;
  private stopped = false;
  private readonly warned = new Set<string>();

  constructor(options: ProcessScannerOptions) {
    this.store = options.store;
    this.log = options.logger;
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runCommand;
    this.psIntervalMs = options.psIntervalMs ?? PS_INTERVAL_MS;
    this.portIntervalMs = options.portIntervalMs ?? PORT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.portTool = this.supported ? 'lsof' : null;
  }

  get supported(): boolean {
    return this.platform === 'darwin' || this.platform === 'linux';
  }

  /** The last sampled process tree, for linking sessions to terminals. */
  get tree(): ProcessTree | null {
    return this.latest;
  }

  start(): void {
    if (!this.supported || this.timers.length > 0) return;
    this.stopped = false;
    void this.scanProcesses().then(() => this.scanPorts());
    this.timers.push(
      setInterval(() => void this.scanProcesses(), this.psIntervalMs),
      setInterval(() => void this.scanPorts(), this.portIntervalMs),
    );
    for (const timer of this.timers) timer.unref();
  }

  /** Stops polling; results of a scan still in flight are dropped. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /** Samples `ps` and updates terminal stats and port ownership. Never throws. */
  async scanProcesses(): Promise<void> {
    if (this.psBusy || !this.supported) return;
    this.psBusy = true;
    try {
      const args =
        this.platform === 'linux'
          ? ['-eo', 'pid=,ppid=,pcpu=,rss=,args=']
          : ['-axo', 'pid=,ppid=,pcpu=,rss=,command='];
      const stdout = await this.run('ps', args);
      if (this.stopped) return;
      this.latest = buildTree(parsePs(stdout));
      this.applyStats();
      this.applyPorts();
    } catch (err) {
      this.warnOnce('ps', err);
    } finally {
      this.psBusy = false;
    }
  }

  /** Samples listening ports. Never throws. */
  async scanPorts(): Promise<void> {
    if (this.portsBusy || this.portTool === null) return;
    this.portsBusy = true;
    try {
      const listeners = await this.readListeners();
      if (this.stopped || listeners === null) return;
      this.listeners = listeners;
      this.applyPorts();
    } finally {
      this.portsBusy = false;
    }
  }

  private async readListeners(): Promise<Listener[] | null> {
    if (this.portTool === 'lsof') {
      try {
        return parseLsof(await this.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']));
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') {
          this.warnOnce('lsof', err);
          return null;
        }
        this.portTool = this.platform === 'linux' ? 'ss' : null;
        this.log.debug({ fallback: this.portTool }, 'lsof not found');
        if (this.portTool === null) return null;
      }
    }
    try {
      return parseSs(await this.run('ss', ['-ltnp']));
    } catch (err) {
      if (errorCode(err) === 'ENOENT') this.portTool = null;
      this.warnOnce('ss', err);
      return null;
    }
  }

  private applyStats(): void {
    if (!this.latest) return;
    const terminals = Object.values(this.store.state.terminals);
    const { stats, owner } = attributeTerminals(this.latest, terminals, this.now());
    this.owner = owner;
    for (const [id, next] of stats) {
      if (!sameStats(this.store.state.terminals[id]?.stats ?? null, next)) {
        this.store.setTerminalStats(id, next);
      }
    }
  }

  private applyPorts(): void {
    if (this.portTool === null) return;
    // Pids that exited since the last port scan no longer listen.
    const live = this.latest
      ? this.listeners.filter((listener) => this.latest?.procs.has(listener.pid))
      : this.listeners;
    this.store.setPorts(bindPorts(live, this.owner, this.store.state.terminals, this.now()));
  }

  private warnOnce(tool: string, err: unknown): void {
    if (this.warned.has(tool)) {
      this.log.debug({ err, tool }, 'process scan failed');
      return;
    }
    this.warned.add(tool);
    this.log.warn({ err, tool }, 'process scan failed');
  }
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

/** `execFile` without a shell; lsof's "nothing found" exit 1 still yields its stdout. */
export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
      (err, stdout) => {
        if (!err) resolve(stdout);
        else if (err.code === 1 && !err.killed) resolve(stdout);
        else reject(err);
      },
    );
  });

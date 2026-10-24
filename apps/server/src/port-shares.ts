import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import {
  PortNumber,
  type PortShare,
  type PortSharesResponse,
  type PortShareUnavailable,
} from '@c-board/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultEditorCliDeps, type EditorCliDeps, findOnPath } from './editor-cli.js';
import type { BoardStore } from './store.js';

export const PORT_SHARES_KEY = 'remote.portShares';
/** The CLI inside the macOS app (App Store or standalone), for a server started outside a shell. */
export const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
/** `serve --bg` can wait on an approval in the admin console; it never blocks a request longer. */
const SERVE_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 5_000;
const FIND_TTL_MS = 30_000;
const SELF_TTL_MS = 30_000;
const SERVE_STATUS_TTL_MS = 10_000;
/** A shared port must stay closed this long before its serve entry goes. */
export const CLOSED_GRACE_MS = 3_000;
const MAX_MESSAGE = 600;

export type CliResult =
  | { ok: true; stdout: string }
  | { ok: false; error: 'not_found' | 'failed' | 'timeout'; output: string };

/** The `tailscale` CLI: where it is, and running it with an argument array. */
export interface TailscaleCli {
  find(): Promise<string | null>;
  run(args: readonly string[], timeoutMs: number): Promise<CliResult>;
}

export interface TailscaleCliOptions {
  /** PATH lookup and the child's environment. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deps?: EditorCliDeps;
}

/** The real CLI: `tailscale` on PATH, else (macOS) the app bundle's binary. Never a shell. */
export function createTailscaleCli(options: TailscaleCliOptions = {}): TailscaleCli {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const deps = options.deps ?? defaultEditorCliDeps(env);
  let found: { path: string | null; at: number } | null = null;
  const find = async () => {
    if (found && Date.now() - found.at < FIND_TTL_MS) return found.path;
    let path = (await findOnPath(deps, 'tailscale')) ?? null;
    if (!path && platform === 'darwin' && (await deps.isExecutable(MAC_APP_TAILSCALE))) {
      path = MAC_APP_TAILSCALE;
    }
    found = { path, at: Date.now() };
    return path;
  };
  return {
    find,
    run: async (args, timeoutMs) => {
      const file = await find();
      if (!file) return { ok: false, error: 'not_found', output: '' };
      return new Promise((done) => {
        execFile(
          file,
          [...args],
          { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (!err) return done({ ok: true, stdout });
            const output = `${stderr}\n${stdout}`.trim();
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            if (e.code === 'ENOENT') {
              found = null;
              return done({ ok: false, error: 'not_found', output });
            }
            done({ ok: false, error: e.killed ? 'timeout' : 'failed', output });
          },
        );
      });
    },
  };
}

const SelfStatus = z.object({
  BackendState: z.string().optional(),
  Self: z.object({ DNSName: z.string() }).partial().nullish(),
});

/** `tailscale serve status --json`: the ports with a serve entry, from `TCP` and `Web`. */
const ServeStatus = z.object({
  TCP: z.record(z.string(), z.unknown()).nullish(),
  Web: z.record(z.string(), z.unknown()).nullish(),
});

export function servedPorts(json: string): Set<number> | null {
  let raw: unknown;
  try {
    raw = json.trim() === '' ? {} : JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = ServeStatus.safeParse(raw);
  if (!parsed.success) return null;
  const ports = new Set<number>();
  const add = (value: string) => {
    const port = PortNumber.safeParse(value);
    if (port.success) ports.add(port.data);
  };
  for (const key of Object.keys(parsed.data.TCP ?? {})) add(key);
  for (const key of Object.keys(parsed.data.Web ?? {})) add(key.slice(key.lastIndexOf(':') + 1));
  return ports;
}

/**
 * Asks the dev server, as the tailnet would, whether it serves that name: Vite answers 403
 * "Blocked request" for hosts missing from `server.allowedHosts`.
 */
export function probeViteBlock(
  target: { address: string; port: number },
  host: string,
  timeoutMs = 2_000,
): Promise<'vite_blocked' | null> {
  return new Promise((done) => {
    const req = httpRequest(
      {
        host: target.address,
        port: target.port,
        path: '/',
        method: 'GET',
        headers: { host: `${host}:${target.port}`, accept: 'text/html' },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 8_192) res.destroy();
        });
        const finish = () =>
          done(res.statusCode === 403 && /blocked request/i.test(body) ? 'vite_blocked' : null);
        res.on('end', finish);
        res.on('close', finish);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
    req.end();
  });
}

const StoredShare = z.object({ port: PortNumber, sharedAt: z.number().int() });
type StoredShare = z.infer<typeof StoredShare>;

export type ShareResult =
  | { ok: true; share: PortShare }
  | {
      ok: false;
      error: 'unavailable' | 'board_port' | 'not_listening' | 'serve_failed';
      message: string;
    };

export type UnshareResult = { ok: true } | { ok: false; error: 'not_shared' | 'foreign' };

export interface PortSharesOptions {
  store: BoardStore;
  cli: TailscaleCli;
  /** The board's bookkeeping: the serve entries it created. */
  load(): unknown;
  save(shares: unknown): void;
  /** Phone access (12.5) is set up: an allowed host exists. */
  phoneAccess(): boolean;
  /** The board's own port: never shared, and its serve entry is never touched. */
  boardPort: number;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'debug'>;
  probe?: (
    target: { address: string; port: number },
    host: string,
  ) => Promise<'vite_blocked' | null>;
  now?: () => number;
  closedGraceMs?: number;
}

/**
 * Dev servers on the phone (12.6e2): `tailscale serve --https=<port>` for a listening port,
 * tailnet only. The board removes only the entries it created (kept in its data dir), when the
 * port stops listening, on Stop sharing and when the server stops.
 */
export class PortShares {
  private readonly options: PortSharesOptions;
  private readonly now: () => number;
  private readonly probe: NonNullable<PortSharesOptions['probe']>;
  private shares = new Map<number, StoredShare>();
  private readonly hints = new Map<number, 'vite_blocked' | null>();
  /** Entries left by a run that didn't stop cleanly: removed on start. */
  private leftover: StoredShare[];
  private self: { host: string | null; at: number } | null = null;
  private served: { ports: Set<number>; at: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private closedTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: PortSharesOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.probe = options.probe ?? probeViteBlock;
    const stored = options.load();
    this.leftover = Array.isArray(stored)
      ? stored.flatMap((s) => {
          const parsed = StoredShare.safeParse(s);
          return parsed.success && parsed.data.port !== options.boardPort ? [parsed.data] : [];
        })
      : [];
  }

  /** Removes the last run's entries, then watches for shared ports that stop listening. */
  async start(): Promise<void> {
    const leftover = this.leftover;
    this.leftover = [];
    if (leftover.length > 0) {
      await this.serialize(async () => {
        for (const share of leftover) await this.serveOff(share.port);
        this.persist();
      });
    }
    if (this.stopped) return;
    this.unsubscribe = this.options.store.onPatch((ops) => {
      if (this.shares.size > 0 && ops.some((op) => op.path[0] === 'ports')) this.scheduleCheck();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.closedTimer) clearTimeout(this.closedTimer);
    await this.serialize(async () => {
      for (const port of [...this.shares.keys()]) await this.drop(port);
    });
  }

  async status(): Promise<PortSharesResponse> {
    const reason = await this.unavailable();
    const host = reason === null ? await this.host() : (this.self?.host ?? null);
    const shares = host === null ? [] : await this.list(host);
    return { available: reason === null, reason, host, shares };
  }

  share(port: number): Promise<ShareResult> {
    return this.serialize(async (): Promise<ShareResult> => {
      if (port === this.options.boardPort) {
        return { ok: false, error: 'board_port', message: 'That is the board itself.' };
      }
      const reason = await this.unavailable();
      const host = reason === null ? await this.host() : null;
      if (reason !== null || host === null) {
        return {
          ok: false,
          error: 'unavailable',
          message: UNAVAILABLE_TEXT[reason ?? 'not_connected'],
        };
      }
      const target = this.target(port);
      if (!target) {
        return { ok: false, error: 'not_listening', message: `Nothing listens on :${port}.` };
      }
      const existing = this.shares.get(port);
      if (existing) return { ok: true, share: this.view(host, port, true, existing.sharedAt) };
      const served = await this.servedPorts(true);
      if (served?.has(port)) {
        // The user serves it already: show it, never take it over.
        return { ok: true, share: this.view(host, port, false, null) };
      }
      const result = await this.options.cli.run(
        ['serve', '--bg', `--https=${port}`, `http://${target.url}`],
        SERVE_TIMEOUT_MS,
      );
      this.served = null;
      if (!result.ok) {
        this.options.logger.warn({ port, error: result.error }, 'tailscale serve failed');
        return { ok: false, error: 'serve_failed', message: serveFailedText(result) };
      }
      const sharedAt = this.now();
      this.shares.set(port, { port, sharedAt });
      this.persist();
      this.options.logger.info({ port }, 'shared a port on the tailnet');
      this.hints.set(port, await this.probe(target, host).catch(() => null));
      return { ok: true, share: this.view(host, port, true, sharedAt) };
    });
  }

  unshare(port: number): Promise<UnshareResult> {
    return this.serialize(async (): Promise<UnshareResult> => {
      if (this.shares.has(port)) {
        await this.drop(port);
        return { ok: true };
      }
      const served = port === this.options.boardPort ? null : await this.servedPorts(false);
      return { ok: false, error: served?.has(port) ? 'foreign' : 'not_shared' };
    });
  }

  /** The board's own entries, for tests and status. */
  get ownPorts(): number[] {
    return [...this.shares.keys()].sort((a, b) => a - b);
  }

  private scheduleCheck(): void {
    if (this.closedTimer || this.stopped) return;
    const closed = () => this.ownPorts.filter((port) => !this.target(port));
    if (closed().length === 0) return;
    this.closedTimer = setTimeout(() => {
      this.closedTimer = null;
      void this.serialize(async () => {
        for (const port of closed()) {
          this.options.logger.info({ port }, 'port closed: stopped sharing it');
          await this.drop(port);
        }
      });
    }, this.options.closedGraceMs ?? CLOSED_GRACE_MS);
    this.closedTimer.unref?.();
  }

  private async drop(port: number): Promise<void> {
    await this.serveOff(port);
    this.shares.delete(port);
    this.hints.delete(port);
    this.persist();
  }

  private async serveOff(port: number): Promise<void> {
    if (port === this.options.boardPort) return;
    const result = await this.options.cli.run(
      ['serve', `--https=${port}`, 'off'],
      STATUS_TIMEOUT_MS,
    );
    this.served = null;
    if (!result.ok) this.options.logger.debug({ port, error: result.error }, 'serve off failed');
  }

  /** Where the listening port answers: IPv6 loopback only when it listens nowhere else. */
  private target(port: number): { address: string; port: number; url: string } | null {
    const bindings = Object.values(this.options.store.state.ports).filter((p) => p.port === port);
    if (bindings.length === 0) return null;
    const v6Only = bindings.every((b) => b.address === '::1');
    return v6Only
      ? { address: '::1', port, url: `[::1]:${port}` }
      : { address: '127.0.0.1', port, url: `127.0.0.1:${port}` };
  }

  private async unavailable(): Promise<PortShareUnavailable | null> {
    if (!this.options.phoneAccess()) return 'no_phone_access';
    if ((await this.options.cli.find()) === null) return 'not_installed';
    return (await this.host()) === null ? 'not_connected' : null;
  }

  private async host(): Promise<string | null> {
    if (this.self && this.now() - this.self.at < SELF_TTL_MS) return this.self.host;
    const result = await this.options.cli.run(['status', '--json'], STATUS_TIMEOUT_MS);
    let host: string | null = null;
    if (result.ok) {
      try {
        const parsed = SelfStatus.safeParse(JSON.parse(result.stdout));
        const name = parsed.success ? (parsed.data.Self?.DNSName ?? '') : '';
        const running = !parsed.success || (parsed.data.BackendState ?? 'Running') === 'Running';
        host = running && name ? name.replace(/\.$/, '').toLowerCase() : null;
      } catch {
        host = null;
      }
    }
    this.self = { host, at: this.now() };
    return host;
  }

  private async servedPorts(fresh: boolean): Promise<Set<number> | null> {
    if (!fresh && this.served && this.now() - this.served.at < SERVE_STATUS_TTL_MS) {
      return this.served.ports;
    }
    const result = await this.options.cli.run(['serve', 'status', '--json'], STATUS_TIMEOUT_MS);
    const ports = result.ok ? servedPorts(result.stdout) : null;
    if (ports) this.served = { ports, at: this.now() };
    return ports;
  }

  private async list(host: string): Promise<PortShare[]> {
    const own = [...this.shares.values()].map((s) => this.view(host, s.port, true, s.sharedAt));
    const served = await this.servedPorts(false);
    const foreign = [...(served ?? [])]
      // 443 is the board's own `tailscale serve --bg 4317` entry, not a dev server.
      .filter((port) => port !== this.options.boardPort && port !== 443 && !this.shares.has(port))
      .map((port) => this.view(host, port, false, null));
    return [...own, ...foreign].sort((a, b) => a.port - b.port);
  }

  private view(host: string, port: number, mine: boolean, sharedAt: number | null): PortShare {
    return {
      port,
      url: `https://${host}:${port}`,
      mine,
      sharedAt,
      hint: this.hints.get(port) ?? null,
    };
  }

  private persist(): void {
    this.options.save([...this.shares.values()]);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
}

const UNAVAILABLE_TEXT: Record<PortShareUnavailable, string> = {
  not_installed: 'Install Tailscale on this Mac first.',
  no_phone_access: 'Set up phone access in Settings → Phone first.',
  not_connected: 'Tailscale isn’t running or signed in on this Mac.',
};

function serveFailedText(result: Extract<CliResult, { ok: false }>): string {
  const output = result.output.replace(/\s+\n/g, '\n').trim().slice(0, MAX_MESSAGE);
  if (result.error === 'timeout') {
    return `Tailscale is still waiting, usually for Serve to be approved on your tailnet.${
      output ? ` It said: ${output}` : ''
    }`;
  }
  if (result.error === 'not_found') return UNAVAILABLE_TEXT.not_installed;
  return output || 'tailscale serve failed.';
}

const PortParams = z.object({ port: PortNumber });

const STATUS_FOR: Record<Extract<ShareResult, { ok: false }>['error'], number> = {
  unavailable: 409,
  board_port: 400,
  not_listening: 409,
  serve_failed: 502,
};

/** `/api/ports/shares` and `/api/ports/:port/share`, behind the auth guard. */
export function registerPortShareRoutes(app: FastifyInstance, shares: PortShares): void {
  app.get('/api/ports/shares', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return shares.status() satisfies Promise<PortSharesResponse>;
  });

  app.post('/api/ports/:port/share', async (request, reply) => {
    const params = PortParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request' });
    const result = await shares.share(params.data.port);
    if (!result.ok) {
      return reply
        .code(STATUS_FOR[result.error])
        .send({ error: result.error, message: result.message });
    }
    return result.share;
  });

  app.delete('/api/ports/:port/share', async (request, reply) => {
    const params = PortParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request' });
    const result = await shares.unshare(params.data.port);
    if (!result.ok)
      return reply.code(result.error === 'foreign' ? 409 : 404).send({ error: result.error });
    return { ok: true };
  });
}

import { chmod, lstat, rename, stat, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { LOCAL_SOCKET_FILE } from '@yardmaster/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

/** `sun_path` is 104 bytes on macOS (108 on Linux), including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;
/** A restarting server (`pnpm dev`) may still hold the socket for a moment. */
const LIVE_RETRIES = 5;
const LIVE_RETRY_MS = 200;
const PROBE_TIMEOUT_MS = 500;

const localRequests = new WeakSet<IncomingMessage>();

/** True for a request that arrived on the local socket rather than on TCP. */
export function isLocalChannel(request: IncomingMessage): boolean {
  return localRequests.has(request);
}

export function socketPath(home: string): string {
  return join(home, LOCAL_SOCKET_FILE);
}

export type LocalChannelState =
  | { kind: 'listening'; path: string }
  | { kind: 'unavailable'; path: string; reason: string };

export class LocalChannelError extends Error {
  override name = 'LocalChannelError';
}

const uid = (): number | undefined => process.getuid?.();

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/** Whether a server answers on the socket right now. */
function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (live: boolean) => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Makes the data dir private (0700, ours) and clears the way for the socket: a stale socket of
 * ours is removed, anything else at that path is left alone and refused.
 */
export async function prepareSocket(home: string, path: string): Promise<void> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new LocalChannelError(`the socket path is too long (${Buffer.byteLength(path)} bytes)`);
  }
  // The token is written first, so the dir exists by now.
  const dir = await stat(home);
  if (!dir.isDirectory()) throw new LocalChannelError('the data dir is not a directory');
  if (uid() !== undefined && dir.uid !== uid()) {
    throw new LocalChannelError('the data dir belongs to another user');
  }
  // Other users must not be able to reach, replace or squat the socket.
  if ((dir.mode & 0o077) !== 0) await chmod(home, 0o700);

  for (let attempt = 0; ; attempt++) {
    let existing: Awaited<ReturnType<typeof lstat>>;
    try {
      existing = await lstat(path);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return;
      throw err;
    }
    if (!existing.isSocket()) {
      throw new LocalChannelError('something other than a socket is in the way');
    }
    if (uid() !== undefined && existing.uid !== uid()) {
      throw new LocalChannelError('the socket in the way belongs to another user');
    }
    if (!(await isLive(path))) {
      await unlink(path).catch((err: unknown) => {
        if (!isErrno(err, 'ENOENT')) throw err;
      });
      return;
    }
    if (attempt >= LIVE_RETRIES) {
      throw new LocalChannelError('another Yardmaster server is using it');
    }
    await new Promise((resolve) => setTimeout(resolve, LIVE_RETRY_MS));
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Serves the app on `<home>/board.sock` (0600, in the 0700 data dir) besides TCP. Requests that
 * arrive here are marked, so the security layer can tell the channels apart. Created with the
 * app (Fastify takes no hooks once started); `listen` runs after the app is ready.
 */
export class LocalChannel {
  private readonly server: Server;
  private owned: { path: string; ino: number; dev: number } | null = null;
  state: LocalChannelState | null = null;

  constructor(
    app: FastifyInstance,
    private readonly logger: FastifyBaseLogger,
  ) {
    // Same timeouts as the TCP server: the permission hook long-polls for minutes.
    this.server = createServer({
      requestTimeout: app.server.requestTimeout,
      headersTimeout: app.server.headersTimeout,
      keepAliveTimeout: app.server.keepAliveTimeout,
    });
    this.server.on('request', (request, response) => {
      localRequests.add(request);
      app.server.emit('request', request, response);
    });
    this.server.on('upgrade', (request, socket, head) => {
      localRequests.add(request);
      app.server.emit('upgrade', request, socket, head);
    });
    app.addHook('onClose', () => this.close());
  }

  /** Never throws: when the socket can't be set up the board runs without it, and says so. */
  async listen(home: string): Promise<LocalChannelState> {
    if (this.state?.kind === 'listening') return this.state;
    const path = socketPath(home);
    // libuv unlinks a socket by name when its server closes, which would take a newer server's
    // socket with it. So it listens under a short temporary name (no longer than the real
    // one) and moves the socket into place; on close we remove it only if it's still ours.
    const temp = join(dirname(path), `.s${process.pid}`.slice(0, LOCAL_SOCKET_FILE.length));
    try {
      await prepareSocket(home, path);
      await unlink(temp).catch(() => {});
      await listen(this.server, temp);
      await chmod(temp, 0o600);
      await rename(temp, path);
      const { ino, dev } = await lstat(path);
      this.owned = { path, ino, dev };
      this.state = { kind: 'listening', path };
    } catch (err) {
      if (this.server.listening) this.server.close();
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { reason },
        'the local socket is unavailable; editors and hooks cannot connect',
      );
      this.state = { kind: 'unavailable', path, reason };
    }
    return this.state;
  }

  private async close(): Promise<void> {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    const owned = this.owned;
    if (!owned) return;
    try {
      const current = await lstat(owned.path);
      if (current.ino === owned.ino && current.dev === owned.dev) await unlink(owned.path);
    } catch {
      // Already gone.
    }
  }
}

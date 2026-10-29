import { lstat, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { DashboardLinkResponse, LOCAL_ROUTES, LOCAL_SOCKET_FILE } from '@yardmaster/protocol';
import { readToken } from './token.js';

export const TOKEN_HEADER = 'x-yardmaster-token';
const LINK_TIMEOUT_MS = 3_000;
const MAX_LINK_BYTES = 4 * 1024;

/** Where the board listens for this user: its socket, and the token to show it. */
export interface LocalBoard {
  socketPath: string;
  token: string;
}

export type Located = { ok: true; board: LocalBoard } | { ok: false; reason: string };

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/**
 * Finds the board's socket in the first data dir with a token, and checks it is really this
 * user's board before anything is sent: the dir is ours and private, and the socket is a socket
 * we own, not a link. No other user can create such a file, so whatever answers there is the
 * board (PRD §8 item 13). Nothing ever goes to the TCP port, which any program could bind first.
 */
export async function locateBoard(
  dirs: readonly string[],
  uid: number | undefined = process.getuid?.(),
): Promise<Located> {
  for (const dir of dirs) {
    const token = await readToken(dir);
    if (token === null) continue;
    try {
      const info = await stat(dir);
      if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
        return { ok: false, reason: 'the Yardmaster data dir is open to other users' };
      }
      const socketPath = join(dir, LOCAL_SOCKET_FILE);
      const socket = await lstat(socketPath);
      if (!socket.isSocket() || (uid !== undefined && socket.uid !== uid)) {
        return { ok: false, reason: `${LOCAL_SOCKET_FILE} is not a socket of yours` };
      }
      return { ok: true, board: { socketPath, token } };
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { ok: false, reason: 'the server is not running' };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, reason: 'no token yet (is the Yardmaster server installed?)' };
}

/** A sign-in link on this machine's loopback, the only kind the extension opens. */
export function isBoardLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '';
  } catch {
    return false;
  }
}

/** Asks the board (over its socket) for the link that signs a browser in, or null. */
export function requestDashboardLink(
  board: LocalBoard,
  timeoutMs = LINK_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: board.socketPath,
        method: 'POST',
        path: LOCAL_ROUTES.dashboardLink,
        headers: { [TOKEN_HEADER]: board.token },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.length > MAX_LINK_BYTES) req.destroy();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return resolve(null);
          }
          const parsed = DashboardLinkResponse.safeParse(body);
          resolve(parsed.success && isBoardLink(parsed.data.url) ? parsed.data.url : null);
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

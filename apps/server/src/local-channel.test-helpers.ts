import { mkdtemp, rm } from 'node:fs/promises';
import { type IncomingHttpHeaders, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll } from 'vitest';
import WebSocket from 'ws';

// Editors and hooks reach the board only on its socket, so tests that play them need a real one:
// `app.inject` always looks like TCP.

const sockets = new WeakMap<FastifyInstance, Promise<string>>();
const homes: string[] = [];

// The apps remove their own sockets when they close; the throwaway dirs go after the file.
afterAll(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/**
 * The app's socket: the one `startServer` opened, or else one in a throwaway dir (once per app).
 */
export function localSocket(app: FastifyInstance): Promise<string> {
  const state = app.localChannel.state;
  if (state?.kind === 'listening') return Promise.resolve(state.path);
  let path = sockets.get(app);
  if (!path) {
    path = (async () => {
      const home = await mkdtemp(join(tmpdir(), 'ym-sock-'));
      const state = await app.localChannel.listen(home);
      homes.push(home);
      if (state.kind !== 'listening') throw new Error(`local channel: ${state.reason}`);
      return state.path;
    })();
    sockets.set(app, path);
  }
  return path;
}

export interface LocalResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
  json(): unknown;
}

export interface LocalRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: string;
}

/** Like `app.inject`, but over the socket, as the hook and the extension call the board. */
export async function localInject(
  app: FastifyInstance,
  { method = 'GET', url, headers = {}, payload }: LocalRequest,
): Promise<LocalResponse> {
  const socketPath = await localSocket(app);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path: url, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body,
          json: () => JSON.parse(body),
        }),
      );
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** A WebSocket to `path` over a socket, as the extension connects to `/ws/editor`. */
export function localWebSocket(
  socketPath: string,
  path: string,
  headers: Record<string, string> = {},
): WebSocket {
  return new WebSocket(`ws://localhost${path}`, {
    headers,
    createConnection: () => connect(socketPath),
  });
}

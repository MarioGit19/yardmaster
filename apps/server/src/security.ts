import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE_SEC, type RemoteDevices } from './remote.js';
import { tokensEqual } from './token.js';

export const SESSION_COOKIE = 'cboard_session';
export const TOKEN_HEADER = 'x-cboard-token';

/** Routes under /api that stay reachable without credentials. */
const PUBLIC_API_ROUTES = new Set(['/api/health']);

const authQuery = z.object({ t: z.string().min(1).max(256).optional() });
const pairQuery = z.object({ c: z.string().min(1).max(256) });

function sign(token: string, nonce: string): string {
  return createHmac('sha256', token).update(`c-board-session:${nonce}`).digest('base64url');
}

/** A cookie value bound to the current token: rotating the token invalidates every session. */
export function createSessionValue(token: string): string {
  const nonce = randomBytes(16).toString('base64url');
  return `${nonce}.${sign(token, nonce)}`;
}

export function verifySessionValue(token: string, value: string): boolean {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return false;
  return tokensEqual(value.slice(dot + 1), sign(token, value.slice(0, dot)));
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

function isProtectedPath(path: string | undefined): boolean {
  if (path === undefined || PUBLIC_API_ROUTES.has(path)) return false;
  return path === '/api' || path.startsWith('/api/');
}

function hostWithPort(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`.toLowerCase();
}

export interface SecurityOptions {
  config: ServerConfig;
  /** The install token, or a getter for one that can be rotated while the server runs. */
  token: string | (() => string);
  /** Phone access (F27): the allowed Tailscale names and the paired devices. Off without it. */
  remote?: { hosts: () => readonly string[]; devices: RemoteDevices };
}

/** Sets the session cookie for the current token on a reply. */
export function setSessionCookie(reply: FastifyReply, token: string): FastifyReply {
  const cookie = [
    `${SESSION_COOKIE}=${createSessionValue(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ');
  return reply.header('set-cookie', cookie);
}

function setDeviceCookie(reply: FastifyReply, value: string): FastifyReply {
  const cookie = [
    `${DEVICE_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Secure',
    `Max-Age=${DEVICE_COOKIE_MAX_AGE_SEC}`,
  ].join('; ');
  return reply.header('set-cookie', cookie);
}

const PAIR_FAILED: Record<'invalid' | 'expired', string> = {
  invalid: 'This pairing code was already used or replaced by a newer one.',
  expired: 'This pairing code has expired.',
};

/** A plain page for the phone's browser: a pairing link is opened from the camera, not the app. */
function pairPage(reply: FastifyReply, status: number, message: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>c-board</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0e;color:#e8e9ec;padding:24px;box-sizing:border-box}main{max-width:340px}h1{font-size:18px;font-weight:600;margin:0 0 8px}p{margin:0;color:#a3a6ad}</style></head><body><main><h1>Could not pair</h1><p>${message} On your Mac, open c-board → Settings → Phone and scan a new code.</p></main></body></html>`;
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8')
    .send(html);
}

/**
 * PRD §8: Host allowlist (DNS-rebinding defence), Origin check, `/auth?t=` cookie bootstrap
 * and the token guard for `/api/*`. Register before any route.
 */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const { config } = options;
  const currentToken =
    typeof options.token === 'function' ? options.token : () => options.token as string;
  // With CBOARD_PORT=0 the port is only known once the server listens.
  const boardPort = (): number => {
    if (config.port !== 0) return config.port;
    const address = app.server.address();
    return address !== null && typeof address === 'object' ? address.port : 0;
  };

  const devHosts = config.devOrigins.map((origin) => new URL(origin).host.toLowerCase());

  const boardHosts = (): string[] => {
    const port = boardPort();
    const names = new Set(['127.0.0.1', 'localhost', config.host.replace(/^\[|\]$/g, '')]);
    return [...names].map((name) => hostWithPort(name, port));
  };
  const allowedHosts = (): Set<string> => new Set([...boardHosts(), ...devHosts]);
  const allowedOrigins = (): Set<string> =>
    new Set([...boardHosts().map((host) => `http://${host}`), ...config.devOrigins]);

  const remote = options.remote;
  /** The allowed remote name a Host header is for (bare, or with :443), else null. */
  const remoteHostOf = (host: string): string | null => {
    if (!remote) return null;
    const name = host.endsWith(':443') ? host.slice(0, -4) : host;
    return remote.hosts().includes(name) ? name : null;
  };
  const remoteHosts = new WeakMap<FastifyRequest, string>();
  const remoteDevice = (request: FastifyRequest): string | null =>
    remote && remoteHosts.has(request)
      ? remote.devices.verify(readCookie(request.headers.cookie, DEVICE_COOKIE))
      : null;

  const isAuthorized = (request: FastifyRequest): boolean => {
    // Over Tailscale only a paired device's own cookie counts, never the token (PRD §8 item 12).
    if (remoteHosts.has(request)) return remoteDevice(request) !== null;
    const header = request.headers[TOKEN_HEADER];
    const token = currentToken();
    if (typeof header === 'string' && tokensEqual(header, token)) return true;
    const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
    return cookie !== undefined && verifySessionValue(token, cookie);
  };

  const deny = (reply: FastifyReply, status: 401 | 403, error: string) =>
    reply.code(status).header('cache-control', 'no-store').send({ error });

  app.decorateRequest('isAuthorized', function (this: FastifyRequest) {
    return isAuthorized(this);
  });
  app.decorateRequest('isRemote', function (this: FastifyRequest) {
    return remoteHosts.has(this);
  });
  app.decorateRequest('remoteDevice', function (this: FastifyRequest) {
    return remoteDevice(this);
  });

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.toLowerCase();
    const remoteHost = host === undefined ? null : remoteHostOf(host);
    if (!host || (remoteHost === null && !allowedHosts().has(host))) {
      request.log.warn({ host }, 'rejected request with a foreign Host header');
      return deny(reply, 403, 'forbidden_host');
    }

    // Browsers send Origin on cross-origin and state-changing requests; tools like curl,
    // the hook script and the extension send none and authenticate with the token instead.
    const origin = request.headers.origin;
    if (remoteHost !== null) {
      // `tailscale serve` terminates TLS and forwards to 127.0.0.1, saying so in this header.
      if (request.headers['x-forwarded-proto'] !== 'https') {
        request.log.warn({ host }, 'rejected a remote request without HTTPS');
        return deny(reply, 403, 'https_required');
      }
      if (origin !== undefined && origin !== `https://${remoteHost}`) {
        request.log.warn({ origin }, 'rejected cross-origin request');
        return deny(reply, 403, 'forbidden_origin');
      }
      remoteHosts.set(request, remoteHost);
    } else if (origin !== undefined && !allowedOrigins().has(origin)) {
      request.log.warn({ origin }, 'rejected cross-origin request');
      return deny(reply, 403, 'forbidden_origin');
    }

    // Check the matched route as well as the raw path, so percent-encoded variants of an
    // /api route can't slip past the guard.
    const paths = [request.routeOptions.url, request.url.split('?', 1)[0]];
    if (paths.some(isProtectedPath) && !isAuthorized(request)) {
      return deny(reply, 401, 'unauthorized');
    }
  });

  app.get('/auth', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    // The raw token never travels to another device: phones pair instead.
    if (request.isRemote()) return deny(reply, 403, 'pair_required');
    const query = authQuery.safeParse(request.query);
    const t = query.success ? query.data.t : undefined;

    const token = currentToken();
    if (t !== undefined && tokensEqual(t, token)) {
      return setSessionCookie(reply, token).redirect('/', 302);
    }
    if (t === undefined && isAuthorized(request)) return reply.redirect('/', 302);
    return deny(reply, 401, 'unauthorized');
  });

  // The pairing link a phone opens from the QR code: spends the code, sets the device cookie.
  app.get('/pair', async (request, reply) => {
    if (!remote || !request.isRemote()) {
      return deny(reply, 403, 'remote_only');
    }
    const query = pairQuery.safeParse(request.query);
    if (!query.success) return pairPage(reply, 401, PAIR_FAILED.invalid);
    const result = remote.devices.redeem(query.data.c, request.headers['user-agent']);
    if (!result.ok) {
      request.log.warn({ reason: result.error }, 'refused a pairing code');
      return pairPage(reply, 401, PAIR_FAILED[result.error]);
    }
    request.log.info({ device: result.device.name }, 'paired a device');
    return setDeviceCookie(reply, result.cookie)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .redirect('/', 302);
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    /** True when the request carries a valid `X-CBoard-Token` header or session cookie. */
    isAuthorized(): boolean;
    /** True when the request came in on an allowed remote (Tailscale) host. */
    isRemote(): boolean;
    /** The paired device behind a remote request, or null. */
    remoteDevice(): string | null;
  }
}

import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import { tokensEqual } from './token.js';

export const SESSION_COOKIE = 'cboard_session';
export const TOKEN_HEADER = 'x-cboard-token';

/** Routes under /api that stay reachable without credentials. */
const PUBLIC_API_ROUTES = new Set(['/api/health']);

const authQuery = z.object({ t: z.string().min(1).max(256).optional() });

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

  const isAuthorized = (request: FastifyRequest): boolean => {
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

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.toLowerCase();
    if (!host || !allowedHosts().has(host)) {
      request.log.warn({ host }, 'rejected request with a foreign Host header');
      return deny(reply, 403, 'forbidden_host');
    }

    // Browsers send Origin on cross-origin and state-changing requests; tools like curl,
    // the hook script and the extension send none and authenticate with the token instead.
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin)) {
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
    const query = authQuery.safeParse(request.query);
    const t = query.success ? query.data.t : undefined;

    const token = currentToken();
    if (t !== undefined && tokensEqual(t, token)) {
      return setSessionCookie(reply, token).redirect('/', 302);
    }
    if (t === undefined && isAuthorized(request)) return reply.redirect('/', 302);
    return deny(reply, 401, 'unauthorized');
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    /** True when the request carries a valid `X-CBoard-Token` header or session cookie. */
    isAuthorized(): boolean;
  }
}

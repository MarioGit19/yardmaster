import { isIP } from 'node:net';
import {
  LOCAL_ONLY_ROUTES,
  SESSION_HEADER,
  SESSION_PROTOCOL_PREFIX,
  SESSION_STORAGE_KEY,
} from '@yardmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import {
  headerValue,
  LEGACY_DEVICE_COOKIE,
  LEGACY_SESSION_COOKIE,
  LEGACY_TOKEN_HEADER,
} from './legacy.js';
import { isLocalChannel } from './local-channel.js';
import type { BrowserSessions } from './sessions.js';
import { tokensEqual } from './token.js';

export const TOKEN_HEADER = 'x-yardmaster-token';
/** The cookies browsers kept before per-browser sessions. They sign nothing in any more. */
const OLD_COOKIES = ['yardmaster_session', LEGACY_SESSION_COOKIE];
const OLD_DEVICE_COOKIES = ['yardmaster_device', LEGACY_DEVICE_COOKIE];

/** Routes under /api that stay reachable without credentials. */
const PUBLIC_API_ROUTES = new Set(['/api/health']);

const authQuery = z.object({
  c: z.string().min(1).max(256).optional(),
  t: z.string().max(256).optional(),
});
const pairQuery = z.object({ c: z.string().min(1).max(256) });

/** The install token header, also under its old name for one version (hooks and extensions). */
export function tokenHeader(headers: FastifyRequest['headers']): string | undefined {
  return headerValue(headers, TOKEN_HEADER, LEGACY_TOKEN_HEADER);
}

/**
 * The session secret a browser sent: the header on fetches, or a `Sec-WebSocket-Protocol` entry
 * on a WebSocket upgrade (browsers can't set headers there). Cookies never count.
 */
export function sessionSecretOf(request: FastifyRequest): string | undefined {
  const header = request.headers[SESSION_HEADER];
  if (typeof header === 'string') return header;
  if (request.headers.upgrade?.toLowerCase() !== 'websocket') return undefined;
  const protocols = request.headers['sec-websocket-protocol'];
  if (typeof protocols !== 'string') return undefined;
  for (const entry of protocols.split(',')) {
    const value = entry.trim();
    if (value.startsWith(SESSION_PROTOCOL_PREFIX)) {
      return value.slice(SESSION_PROTOCOL_PREFIX.length);
    }
  }
  return undefined;
}

/** The link that signs a browser in with a one-time code; in dev, on the Vite origin. */
export function signInUrl(config: ServerConfig, port: number, code: string): string {
  const origin = config.devOrigins[0] ?? `http://127.0.0.1:${port}`;
  return `${origin}/auth?c=${encodeURIComponent(code)}`;
}

function isProtectedPath(path: string | undefined): boolean {
  if (path === undefined || PUBLIC_API_ROUTES.has(path)) return false;
  return path === '/api' || path.startsWith('/api/');
}

const LOCAL_ONLY = new Set(LOCAL_ONLY_ROUTES);

/** Paths the local socket serves: the API and the editor link, never the web app or `/ws/ui`. */
function isSocketPath(path: string | undefined): boolean {
  return (
    path !== undefined && (LOCAL_ONLY.has(path) || path === '/api' || path.startsWith('/api/'))
  );
}

function hostWithPort(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`.toLowerCase();
}

export interface SecurityOptions {
  config: ServerConfig;
  /** The install token, or a getter for one that can be rotated while the server runs. */
  token: string | (() => string);
  /** Signed-in browsers, on this machine and paired phones. */
  sessions: BrowserSessions;
  /** Phone access (F27): the allowed Tailscale names. Off without it. */
  remote?: { hosts: () => readonly string[] };
}

const expireCookie = (name: string, secure: boolean) =>
  `${name}=; Path=/; HttpOnly; SameSite=Strict;${secure ? ' Secure;' : ''} Max-Age=0`;

const PAGE_STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0e;color:#e8e9ec;padding:24px;box-sizing:border-box}main{max-width:360px}h1{font-size:18px;font-weight:600;margin:0 0 8px}p{margin:0 0 8px;color:#a3a6ad}code{font:14px ui-monospace,monospace;color:#e8e9ec}';

/** A plain page outside the app: sign-in and pairing links open before the app has a session. */
function page(reply: FastifyReply, status: number, title: string, body: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Yardmaster</title><style>${PAGE_STYLE}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8')
    .send(html);
}

/**
 * Hands a fresh session secret to the board's own origin: the page stores it and opens the board.
 * The secret is in the body only (no cookie, no URL), on a `no-store` response.
 */
function sessionPage(reply: FastifyReply, secret: string, remote: boolean) {
  const store = `try{localStorage.setItem(${JSON.stringify(SESSION_STORAGE_KEY)},document.querySelector('meta[name="yardmaster-session"]').content)}catch(e){}location.replace('/')`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="yardmaster-session" content="${secret}"><title>Yardmaster</title><style>${PAGE_STYLE}</style></head><body><main><h1>Signing in…</h1><noscript><p>Yardmaster needs JavaScript.</p></noscript></main><script>${store}</script></body></html>`;
  return reply
    .code(200)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header(
      'set-cookie',
      (remote ? [...OLD_COOKIES, ...OLD_DEVICE_COOKIES] : OLD_COOKIES).map((name) =>
        expireCookie(name, remote),
      ),
    )
    .type('text/html; charset=utf-8')
    .send(html);
}

const SIGN_IN_HOW =
  '<p>Run <code>yardmaster open</code> in a terminal on this computer, or use <b>Yardmaster: Open Dashboard</b> in your editor.</p>';

const SIGN_IN_FAILED: Record<'invalid' | 'expired', string> = {
  invalid: 'This sign-in link was already used.',
  expired: 'This sign-in link has expired.',
};
const PAIR_FAILED: Record<'invalid' | 'expired', string> = {
  invalid: 'This pairing code was already used or replaced by a newer one.',
  expired: 'This pairing code has expired.',
};

/** A plain page for the phone's browser: a pairing link is opened from the camera, not the app. */
function pairPage(reply: FastifyReply, status: number, message: string) {
  return page(
    reply,
    status,
    'Could not pair',
    `<p>${message} On your Mac, open Yardmaster → Settings → Phone and scan a new code.</p>`,
  );
}

/**
 * PRD §8: Host allowlist (DNS-rebinding defence), Origin check, one-time sign-in and pairing
 * links, and the session or token guard for `/api/*`, plus the split between the local socket (editors and
 * hooks, token only) and TCP (browsers). Register before any route.
 */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const { config } = options;
  const currentToken =
    typeof options.token === 'function' ? options.token : () => options.token as string;
  // With YARDMASTER_PORT=0 the port is only known once the server listens.
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

  const { remote, sessions } = options;
  /** The allowed remote name a Host header is for (bare, or with :443), else null. */
  const remoteHostOf = (host: string): string | null => {
    if (!remote) return null;
    const name = host.endsWith(':443') ? host.slice(0, -4) : host;
    return remote.hosts().includes(name) ? name : null;
  };
  const remoteHosts = new WeakMap<FastifyRequest, string>();
  const verified = new WeakMap<FastifyRequest, string | null>();
  /** The browser session behind a TCP request (a phone's over Tailscale), or null. */
  const browserSession = (request: FastifyRequest): string | null => {
    if (isLocalChannel(request.raw)) return null;
    const known = verified.get(request);
    if (known !== undefined) return known;
    const id = sessions.verify(
      sessionSecretOf(request),
      remoteHosts.has(request) ? 'remote' : 'local',
    );
    verified.set(request, id);
    return id;
  };

  const hasToken = (request: FastifyRequest): boolean => {
    const header = tokenHeader(request.headers);
    return header !== undefined && tokensEqual(header, currentToken());
  };

  const isAuthorized = (request: FastifyRequest): boolean => {
    // The socket takes the token header only: no browser can reach it.
    if (isLocalChannel(request.raw)) return hasToken(request);
    // Over Tailscale only a paired phone's own session counts, never the token (PRD §8 item 12).
    if (remoteHosts.has(request)) return browserSession(request) !== null;
    return hasToken(request) || browserSession(request) !== null;
  };

  const deny = (reply: FastifyReply, status: 401 | 403 | 404, error: string) =>
    reply.code(status).header('cache-control', 'no-store').send({ error });

  app.decorateRequest('isAuthorized', function (this: FastifyRequest) {
    return isAuthorized(this);
  });
  app.decorateRequest('isLocalChannel', function (this: FastifyRequest) {
    return isLocalChannel(this.raw);
  });
  app.decorateRequest('isRemote', function (this: FastifyRequest) {
    return remoteHosts.has(this);
  });
  app.decorateRequest('browserSession', function (this: FastifyRequest) {
    return browserSession(this);
  });

  app.addHook('onRequest', async (request, reply) => {
    // The board types into terminals: no page may frame it (clickjacking).
    reply
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "frame-ancestors 'none'");
    // Check the matched route as well as the raw path, so percent-encoded variants of a
    // route can't slip past the guard.
    const paths = [request.routeOptions.url, request.url.split('?', 1)[0]];

    if (isLocalChannel(request.raw)) {
      // Only this user can open the socket, so Host means nothing here; browsers never get here.
      if (request.headers.origin !== undefined) return deny(reply, 403, 'forbidden_origin');
      if (!paths.every(isSocketPath)) return deny(reply, 404, 'not_found');
      if (paths.some(isProtectedPath) && !isAuthorized(request)) {
        return deny(reply, 401, 'unauthorized');
      }
      return;
    }

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

    // The editor and hook channels never run over TCP: whatever answers on the port may not
    // be the board, so the clients never send the token there (PRD §8 item 13).
    if (paths.some((path) => path !== undefined && LOCAL_ONLY.has(path))) {
      return deny(reply, 403, 'local_channel_required');
    }
    if (paths.some(isProtectedPath) && !isAuthorized(request)) {
      return deny(reply, 401, 'unauthorized');
    }
  });

  // A one-time sign-in code (`yardmaster start`, `yardmaster open`, the editor's Open Dashboard).
  app.get('/auth', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    // Nothing signs a browser in on another device: phones pair instead.
    if (request.isRemote()) return deny(reply, 403, 'pair_required');
    const query = authQuery.safeParse(request.query);
    const { c, t } = query.success ? query.data : {};
    if (c === undefined) {
      // `?t=<token>` links put the install token in browser history: they no longer sign in.
      return page(
        reply,
        t === undefined ? 400 : 410,
        t === undefined ? 'Sign in to Yardmaster' : 'Use the new sign-in link',
        `${t === undefined ? '' : '<p>Sign-in links with the access token no longer work. Yardmaster now uses one-time links.</p>'}${SIGN_IN_HOW}`,
      );
    }
    const result = sessions.redeemSignIn(c, request.headers['user-agent']);
    if (!result.ok) {
      request.log.warn({ reason: result.error }, 'refused a sign-in code');
      return page(
        reply,
        401,
        'Could not sign in',
        `<p>${SIGN_IN_FAILED[result.error]}</p>${SIGN_IN_HOW}`,
      );
    }
    request.log.info({ browser: result.session.name }, 'signed in a browser');
    return sessionPage(reply, result.secret, false);
  });

  // The pairing link a phone opens from the QR code: spends the code, sets the device cookie.
  app.get('/pair', async (request, reply) => {
    if (!remote || !request.isRemote()) {
      return deny(reply, 403, 'remote_only');
    }
    const query = pairQuery.safeParse(request.query);
    if (!query.success) return pairPage(reply, 401, PAIR_FAILED.invalid);
    const result = sessions.redeemPairing(query.data.c, request.headers['user-agent']);
    if (!result.ok) {
      request.log.warn({ reason: result.error }, 'refused a pairing code');
      return pairPage(reply, 401, PAIR_FAILED[result.error]);
    }
    request.log.info({ device: result.session.name }, 'paired a device');
    return sessionPage(reply, result.secret, true);
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    /** True when the request carries a valid `X-Yardmaster-Token` header or browser session. */
    isAuthorized(): boolean;
    /** True when the request came in on the local socket (editors and hooks). */
    isLocalChannel(): boolean;
    /** True when the request came in on an allowed remote (Tailscale) host. */
    isRemote(): boolean;
    /** The browser session behind the request (local or a paired phone's), or null. */
    browserSession(): string | null;
  }
}

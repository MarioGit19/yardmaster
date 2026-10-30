import { readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { type BrowserContext, devices, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { type DemoBoard, startDemoBoard } from './board.js';
import { expect, sessionHeader, signedInState, test } from './fixtures.js';
import { signInLink } from './local.js';

// Browser sign-in: one-time codes, per-browser sessions kept in the board origin's storage, and
// nothing in cookies (browsers send a host's cookies to every port on it). Its own board, so
// revoking sessions and pairing never touch the other specs.

const PHONE_HOST = 'dev-mac.tailnet-acme.ts.net';
const { defaultBrowserType: _ios, ...iPhone } = devices['iPhone 13'];

test.describe.configure({ mode: 'default' });
// Notifications (for the service worker's action) need full Chromium; the headless shell denies them.
test.use({ channel: 'chromium' });

let board: DemoBoard;
const servers: Server[] = [];

test.beforeAll(async () => {
  board = await startDemoBoard();
});

test.afterAll(async () => {
  for (const server of servers.splice(0)) server.closeAllConnections();
  for (const server of servers) server.close();
  await board?.stop();
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    }),
  );
}

/** Opens a sign-in link in a fresh browser context; resolves once the board has rendered. */
async function signIn(
  browser: import('@playwright/test').Browser,
  options: Parameters<import('@playwright/test').Browser['newContext']>[0] = {},
): Promise<{ context: BrowserContext; page: Page; secret: string }> {
  const context = await browser.newContext({ baseURL: board.url, ...options });
  const page = await context.newPage();
  await page.goto(await signInLink(board));
  await expect(page).toHaveURL(`${board.url}/`);
  await expect(page.locator('a[href^="#/p/"]:visible').first()).toBeAttached();
  const secret = await page.evaluate(() => localStorage.getItem('yardmaster.session'));
  if (!secret) throw new Error('the sign-in page stored no session');
  return { context, page, secret };
}

/** Resolves with the close code of a `/ws/ui` socket opened with these headers. */
function boardSocketClose(headers: Record<string, string>): Promise<number> {
  const url = new URL(board.url);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${url.host}/ws/ui`, ['yardmaster'], {
      headers: { origin: board.url, ...headers },
    });
    socket.on('message', () => reject(new Error('a socket without a session got board data')));
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('close', (code) => resolve(code));
    socket.on('error', () => {});
  });
}

test('a request with everything a browser sends to another port of the host is refused', async ({
  browser,
}) => {
  // A dev server on another port of the same host, recording what the browser sends it.
  const seen: IncomingHttpHeaders[] = [];
  const devPort = await listen(
    createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>dev server</title><p>hello</p>');
    }),
  );
  const { context, page, secret } = await signIn(browser);
  try {
    // A signed-in browser visits the dev server: the session never leaves the board's origin.
    await page.goto(`http://127.0.0.1:${devPort}/`);
    await expect(page.getByText('hello')).toBeVisible();
    expect(JSON.stringify(seen.at(-1) ?? {})).not.toContain(secret.split('.')[1]);

    // A browser upgraded from the cookie version still holds the old cookies for the host.
    await context.addCookies(
      ['yardmaster_session', 'cboard_session'].map((name) => ({
        name,
        value: secret,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Strict' as const,
      })),
    );
    await page.reload();
    await expect(page.getByText('hello')).toBeVisible();
    const sent = seen.at(-1) ?? {};
    expect(sent.cookie).toContain('yardmaster_session=');

    // Everything the dev server got, replayed at the board, signs nothing in.
    const replay: Record<string, string> = {};
    for (const [name, value] of Object.entries(sent)) {
      if (typeof value === 'string' && !['host', 'connection'].includes(name)) {
        replay[name] = value;
      }
    }
    const status = await fetch(`${board.url}/api/status`, { headers: replay });
    expect(status.status).toBe(401);
    expect(await boardSocketClose(replay)).toBe(4401);
    // Even the old cookie carrying a live secret counts for nothing.
    const cookie = `yardmaster_session=${secret}; cboard_session=${secret}`;
    expect((await fetch(`${board.url}/api/status`, { headers: { cookie } })).status).toBe(401);
    expect(await boardSocketClose({ cookie })).toBe(4401);
    // The header the board's own pages send does.
    expect(
      (await fetch(`${board.url}/api/status`, { headers: sessionHeader(secret) })).status,
    ).toBe(200);
  } finally {
    await context.close();
  }
});

test('a sign-in link works once, and the token link never signs in', async ({ browser }) => {
  const link = await signInLink(board);
  const first = await browser.newContext({ baseURL: board.url });
  const second = await browser.newContext({ baseURL: board.url });
  try {
    const page = await first.newPage();
    await page.goto(link);
    await expect(page.locator('a[href^="#/p/"]:visible').first()).toBeAttached();

    const late = await second.newPage();
    const again = await late.goto(link);
    expect(again?.status()).toBe(401);
    await expect(late.getByRole('heading', { name: 'Could not sign in' })).toBeVisible();
    await expect(late.getByText('already used')).toBeVisible();
    expect(await late.evaluate(() => localStorage.getItem('yardmaster.session'))).toBeNull();

    // The install token in a link (the old way) shows the new-link page and signs nothing in.
    const token = (await readFile(join(board.home, 'token'), 'utf8')).trim();
    const old = await late.goto(`/auth?t=${token}`);
    expect(old?.status()).toBe(410);
    expect(old?.headers()['cache-control']).toBe('no-store');
    await expect(late.getByRole('heading', { name: 'Use the new sign-in link' })).toBeVisible();
    await expect(late.getByText('yardmaster open')).toBeVisible();
    expect(await late.evaluate(() => localStorage.getItem('yardmaster.session'))).toBeNull();
    expect(await second.cookies()).toEqual([]);

    // So the board asks this browser to sign in again, rather than showing a blank board.
    await late.goto('/');
    await expect(late.getByRole('heading', { name: 'Sign in again' })).toBeVisible();
    await expect(late.getByText('yardmaster open')).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});

test('a browser signed in with a cookie before this version is asked to sign in again', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: board.url });
  try {
    await context.addCookies([
      {
        name: 'yardmaster_session',
        value: 'bm9uY2Utb2YtdGhlLW9sZC1raW5k.c2lnbmF0dXJlLW9mLXRoZS1vbGQta2luZA',
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('[data-sign-in]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in again' })).toBeVisible();
    await expect(page.getByText('sign in once more')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('Settings lists the signed-in browsers and signs one out at once', async ({ browser }) => {
  const mine = await signIn(browser);
  const other = await signIn(browser, {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  });
  try {
    const { page } = mine;
    await page.goto('/#/settings');
    const row = page.locator('[data-setting="sessions"]');
    const mineId = mine.secret.split('.')[0] ?? '';
    const otherId = other.secret.split('.')[0] ?? '';
    await expect(row.locator(`[data-session="${mineId}"]`)).toContainText('This browser');
    const theirs = row.locator(`[data-session="${otherId}"]`);
    await expect(theirs).toContainText('Linux · Firefox');
    await expect(theirs).not.toContainText('This browser');

    await theirs.getByRole('button', { name: 'Sign out' }).click();
    await expect(theirs).toHaveCount(0);
    // The other browser's open board closes and asks it to sign in again.
    await expect(other.page.getByRole('heading', { name: 'Sign in again' })).toBeVisible();
    expect(
      (await fetch(`${board.url}/api/status`, { headers: sessionHeader(other.secret) })).status,
    ).toBe(401);
    // This one carries on.
    await expect(row.locator(`[data-session="${mineId}"]`)).toBeVisible();
  } finally {
    await mine.context.close();
    await other.context.close();
  }
});

/**
 * Plays `tailscale serve`: forwards to the board as the phone's HTTPS name, with the headers
 * Tailscale adds, and the phone's origin on requests that carry one.
 */
async function tailscaleServe(): Promise<string> {
  const target = new URL(board.url);
  const rewrite = (headers: IncomingHttpHeaders) => ({
    ...headers,
    host: PHONE_HOST,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.101.102.103',
    ...(headers.origin ? { origin: `https://${PHONE_HOST}` } : {}),
  });
  const server = createServer((req, res) => {
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: rewrite(req.headers),
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = connect(Number(target.port), target.hostname, () => {
      const headers = rewrite(req.headers);
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        value === undefined ? [] : [`${name}: ${Array.isArray(value) ? value.join(', ') : value}`],
      );
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return `http://127.0.0.1:${await listen(server)}`;
}

test('a phone pairs, opens the hub, and answers a request from a notification', async ({
  browser,
}) => {
  test.slow();
  const mac = await signIn(browser, { permissions: ['notifications'] });
  const phoneContext = await browser.newContext({ ...iPhone, permissions: ['notifications'] });
  try {
    const headers = sessionHeader(mac.secret);
    const hosts = await fetch(`${board.url}/api/settings`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ remoteAllowedHosts: [PHONE_HOST] }),
    });
    expect(hosts.status).toBe(200);
    const pairing = await fetch(`${board.url}/api/remote/pair`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    });
    const pairUrl = new URL(((await pairing.json()) as { url: string }).url);
    expect(pairUrl.host).toBe(PHONE_HOST);

    // The phone scans the code: through Tailscale, to the pairing link, then the board.
    const serve = await tailscaleServe();
    const phone = await phoneContext.newPage();
    await phone.goto(`${serve}${pairUrl.pathname}${pairUrl.search}`);
    await expect(phone).toHaveURL(`${serve}/`);
    await expect(phone.locator('[data-phone-shell][data-hydrated]')).toBeAttached();
    const phoneSecret = await phone.evaluate(() => localStorage.getItem('yardmaster.session'));
    expect(phoneSecret).toBeTruthy();
    expect(await phoneContext.cookies()).toEqual([]);
    // A phone's session counts only over Tailscale, never on the Mac's own port.
    expect(
      (await fetch(`${board.url}/api/status`, { headers: sessionHeader(phoneSecret ?? '') }))
        .status,
    ).toBe(401);

    // The Mac lists it as a paired device and as a signed-in phone.
    await mac.page.goto('/#/settings');
    const phoneId = phoneSecret?.split('.')[0] ?? '';
    await expect(mac.page.locator(`[data-device="${phoneId}"]`)).toContainText('iPhone · Safari');
    await expect(
      mac.page.locator(`[data-setting="sessions"] [data-session="${phoneId}"]`),
    ).toContainText('Phone');

    // A phone can't reach what only the Mac may change, but it keeps its own settings.
    const fromPhone = (method: string, path: string, body: unknown) =>
      phone.evaluate(
        async ({ method, path, body, secret }) =>
          (
            await fetch(path, {
              method,
              headers: { 'x-yardmaster-session': secret, 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
          ).status,
        { method, path, body, secret: phoneSecret ?? '' },
      );
    expect(await fromPhone('POST', '/api/token/rotate', {})).toBe(403);
    expect(await fromPhone('PUT', '/api/settings', { libraryRoots: [] })).toBe(403);
    expect(await fromPhone('PUT', '/api/settings', { notifyHideDetails: false })).toBe(200);

    // The hub: a project's page on the phone.
    await phone.goto(`${serve}/#/projects`);
    const project = phone.locator('a[href^="#/p/"]').first();
    await project.click();
    await expect(phone).toHaveURL(/#\/p\//);
    await expect(phone.locator('[data-phone-shell][data-hydrated]')).toBeAttached();

    // A demo request arrives (8–14 s in) and the Mac's sheet shows it.
    await mac.page.goto('/#/');
    const waiting = mac.page.locator('[data-hud="needs-you"]');
    await expect(waiting.locator('[data-value]')).not.toHaveAttribute('data-value', '0', {
      timeout: 30_000,
    });
    await waiting.click();
    const card = mac.page.locator('article[data-approval]').first();
    const approvalId = await card.getAttribute('data-approval');
    if (!approvalId) throw new Error('the approval card has no id');

    // Allow from the phone's notification: the service worker signs the decision in with the
    // phone's session from IndexedDB.
    await phone.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    });
    const worker =
      phoneContext.serviceWorkers()[0] ?? (await phoneContext.waitForEvent('serviceworker'));
    await worker.evaluate(async (id) => {
      const scope = self as unknown as {
        registration: ServiceWorkerRegistration;
        dispatchEvent(event: Event): boolean;
      };
      await scope.registration.showNotification('Claude wants to run Bash', {
        tag: `approval-${id}`,
        data: { url: '/#/', request: id, approvalId: id },
        actions: [{ action: 'allow', title: 'Allow once' }],
      } as NotificationOptions);
      const [notification] = await scope.registration.getNotifications({ tag: `approval-${id}` });
      const Click = (globalThis as unknown as { NotificationEvent: typeof Event })
        .NotificationEvent;
      scope.dispatchEvent(
        new (Click as unknown as new (type: string, init: object) => Event)('notificationclick', {
          notification,
          action: 'allow',
        }),
      );
    }, approvalId);
    await expect(
      mac.page.locator(`article[data-approval="${approvalId}"][data-resolved="allowed"]`),
    ).toBeAttached();
  } finally {
    await phoneContext.close();
    await mac.context.close();
  }
});

test('signedInState signs the shared fixtures in through origin storage only', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a[href^="#/p/"]:visible').first()).toBeAttached();
  expect(await page.context().cookies()).toEqual([]);
  expect(signedInState('http://127.0.0.1:1', 'x.y').cookies).toEqual([]);
});

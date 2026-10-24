import type { BrowserContext, Page } from '@playwright/test';
import { type DemoBoard, startDemoBoard } from './board.js';
import { expect, signedInState, test } from './fixtures.js';

// 12.6e3: push notifications. The demo's push service is simulated (an outbox the server hands
// payloads to), and the browser's PushManager is mocked, since headless Chromium has no push
// service. The service worker is real: the test delivers the outbox to it over CDP. Its own board,
// so the drill's events and toasts never reach the other specs.

const KINDS = ['background', 'claude_finished', 'command_finished', 'crashed', 'needs_you'];

interface ShowPayload {
  type: 'show';
  kind: string;
  title: string;
  body: string;
  tag: string;
  url: string;
}
interface Outbox {
  sent: { subscriptionId: string; payload: ShowPayload | { type: 'close' } }[];
}

test.describe.configure({ mode: 'default' });
// The headless shell always reports notifications as denied; full Chromium grants them.
test.use({ channel: 'chromium' });

let board: DemoBoard;

test.beforeAll(async () => {
  board = await startDemoBoard();
});

test.afterAll(async () => {
  await board?.stop();
});

/** A PushManager that hands out one fake subscription per browser, kept in localStorage. */
async function mockPushManager(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const KEY = 'e2e.push.subscription';
    const make = (endpoint: string) => ({
      endpoint,
      options: {},
      toJSON: () => ({
        endpoint,
        expirationTime: null,
        keys: { p256dh: 'BE2eFakeP256dhKey', auth: 'e2eFakeAuth' },
      }),
      unsubscribe: async () => {
        localStorage.removeItem(KEY);
        return true;
      },
    });
    const proto = PushManager.prototype as unknown as Record<string, unknown>;
    proto.getSubscription = async () => {
      const endpoint = localStorage.getItem(KEY);
      return endpoint ? make(endpoint) : null;
    };
    proto.subscribe = async () => {
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`;
      localStorage.setItem(KEY, endpoint);
      return make(endpoint);
    };
  });
}

async function outbox(page: Page, subscriptionId: string): Promise<ShowPayload[]> {
  const body = (await (await page.request.get('/api/push/outbox')).json()) as Outbox;
  return body.sent.flatMap((s) =>
    s.subscriptionId === subscriptionId && s.payload.type === 'show' ? [s.payload] : [],
  );
}

test('subscribes this device, sends a test, and gets one push per event kind', async ({
  browser,
}) => {
  test.slow();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
    permissions: ['notifications'],
    viewport: { width: 1280, height: 900 },
  });
  await mockPushManager(context);
  let pushId: string | null = null;
  const page = await context.newPage();
  try {
    await page.goto('/#/settings');
    const device = page.locator('[data-setting="push-device"]');
    await expect(device).toContainText('Notifications off');
    await device.getByRole('button', { name: 'Turn on' }).click();
    await expect(device).toContainText('Notifications on');
    pushId = await page.evaluate(() => localStorage.getItem('yardmaster.push.id'));
    expect(pushId).toBeTruthy();
    const id = pushId ?? '';
    await expect(page.locator(`[data-push-device="${id}"]`)).toContainText('This device');

    // Background work is off by default; every event kind is on for this run.
    await page
      .locator('[data-setting="notify-background"]')
      .getByRole('button', { name: 'On' })
      .click();
    await expect
      .poll(async () => (await (await page.request.get('/api/settings')).json()).notifyEvents)
      .toContain('background');

    await device.getByRole('button', { name: 'Send a test' }).click();
    await expect.poll(async () => (await outbox(page, id)).map((p) => p.kind)).toEqual(['test']);

    // Looking at the board: no push, the toast shows instead.
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.request.post('/api/push/drill', { data: {} });
    // Sonner keeps only the newest few toasts on screen; the rest stay in the DOM.
    await expect(page.getByText('drill-command · ✓ pnpm test')).toBeAttached();
    expect((await outbox(page, id)).filter((p) => p.title.startsWith('drill-'))).toEqual([]);

    // The board tab closed: one push per kind.
    await page.close();
    const api = context.request;
    await api.post('/api/push/drill', { data: {} });
    const res = (await (await api.get('/api/push/outbox')).json()) as Outbox;
    const drill = res.sent.flatMap((s) =>
      s.subscriptionId === id && s.payload.type === 'show' && s.payload.title.startsWith('drill-')
        ? [s.payload]
        : [],
    );
    expect(drill.map((p) => p.kind).sort()).toEqual(KINDS);
    expect(drill.map((p) => p.title).sort()).toEqual([
      'drill-background · A subagent finished',
      'drill-command · ✓ pnpm test',
      'drill-crash · pnpm dev crashed',
      'drill-finished · Claude finished',
      'drill-needs · Claude wants to run Bash',
    ]);

    // The service worker shows each one.
    const sw = await context.newPage();
    await sw.goto('/#/');
    await sw.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    const cdp = await context.newCDPSession(sw);
    const registrations = new Map<string, string>();
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations: list }) => {
      for (const r of list) if (!r.isDeleted) registrations.set(r.scopeURL, r.registrationId);
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => registrations.get(`${board.url}/`)).toBeTruthy();
    const registrationId = registrations.get(`${board.url}/`) ?? '';
    for (const payload of drill) {
      await cdp.send('ServiceWorker.deliverPushMessage', {
        origin: board.url,
        registrationId,
        data: JSON.stringify(payload),
      });
    }
    await expect
      .poll(() =>
        sw.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          const shown = await registration.getNotifications();
          return shown.map((n) => n.title).sort();
        }),
      )
      .toEqual(drill.map((p) => p.title).sort());
  } finally {
    const api = context.request;
    await api.put('/api/settings', {
      data: { notifyEvents: ['needs_you', 'claude_finished', 'command_finished', 'crashed'] },
    });
    if (pushId) await api.delete(`/api/push/subscriptions/${pushId}`);
    await context.close();
  }
});

import { devices, type Page } from '@playwright/test';
import { type DemoBoard, startDemoBoard } from './board.js';
import { expect, sessionHeader, signedInState, test } from './fixtures.js';

// Closing and forgetting projects, on their own demo board (closing changes what it shows).

let board: DemoBoard;

test.beforeAll(async () => {
  board = await startDemoBoard();
});

test.afterAll(async () => {
  await board?.stop();
});

async function liveBoardTerminals(page: Page): Promise<number> {
  const response = await page.request.get('/api/status', { headers: sessionHeader(board.session) });
  const status = (await response.json()) as { boardTerminals: { live: number } };
  return status.boardTerminals.live;
}

/** `terminal.create` straight over `/ws/ui`, as another tab would: no board view opens it. */
async function createTerminal(page: Page, projectId: string): Promise<void> {
  const ok = await page.evaluate(async (id) => {
    // Signed in like the app: the session from this origin's storage, as a subprotocol.
    const session = localStorage.getItem('yardmaster.session');
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/ui`, [
      'yardmaster',
      `yardmaster.session.${session}`,
    ]);
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });
    const result = new Promise<boolean>((resolve) => {
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === 'action.result' && message.payload.id === 'e2e-create') {
          resolve(message.payload.ok);
        }
      };
    });
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'action',
        id: 'e2e-create',
        ts: Date.now(),
        payload: { kind: 'terminal.create', projectId: id },
      }),
    );
    const done = await result;
    ws.close();
    return done;
  }, projectId);
  expect(ok).toBe(true);
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('closes a project with a board terminal, which comes back with a new one, then forgets it', async ({
    browser,
  }) => {
    test.slow();
    const context = await browser.newContext({
      baseURL: board.url,
      storageState: signedInState(board.url, board.session),
      viewport: { width: 1440, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto('/#/');

      // A library folder opened with a terminal on the board.
      await page.locator('[data-rail-open-project]').click();
      const picker = page.locator('[data-open-project]');
      await picker.locator('[data-library-entry="weather-bot"]').click();
      const sheet = picker.locator('[data-launch-sheet="weather-bot"]');
      await sheet.locator('[data-launch-option="editor"] label').click();
      await sheet.locator('[data-launch-option="terminal"] label').click();
      await sheet.getByRole('button', { name: 'Open project' }).click();
      await expect(
        page.locator('[data-terminal-stack] [role="tab"][data-origin="board"]'),
      ).toBeVisible({
        timeout: 10_000,
      });
      const projectId = decodeURIComponent(
        (await page.evaluate(() => location.hash)).match(/#\/p\/([^/]+)/)?.[1] ?? '',
      );
      expect(projectId).not.toBe('');
      await expect.poll(() => liveBoardTerminals(page)).toBe(1);

      await page.goto('/#/');
      const pod = page.locator(`[data-pod="${projectId}"]`);
      await expect(pod).toBeVisible();

      // The pod's menu: the confirm lists the running board terminal.
      await pod.click({ button: 'right' });
      await page
        .locator(`[data-pod-menu="${projectId}"]`)
        .getByRole('menuitem', { name: 'Close project…' })
        .click();
      const confirm = page.locator(`[data-close-project="${projectId}"]`);
      await expect(confirm).toBeVisible();
      await expect(confirm.getByRole('heading', { name: 'Close weather-bot?' })).toBeVisible();
      await expect(confirm.locator('[data-close-group="stop"]')).toContainText('weather-bot');
      // No editor window is open on it, so nothing to tick.
      await expect(confirm.locator('[data-close-window]')).toHaveCount(0);
      await confirm.locator('[data-close-confirm]').click();
      await expect(confirm).toHaveCount(0);

      // It leaves the overview and the rail; its terminal stops (Ctrl+C, then a kill).
      await expect(pod).toHaveCount(0);
      const rail = page.locator('nav[aria-label="Projects"]');
      await expect(rail.getByRole('link', { name: /weather-bot/ })).toHaveCount(0);
      await expect.poll(() => liveBoardTerminals(page), { timeout: 8_000 }).toBe(0);

      // A new terminal there brings it back.
      await createTerminal(page, projectId);
      await expect(pod).toBeVisible({ timeout: 10_000 });
      await expect(rail.getByRole('link', { name: /weather-bot/ })).toHaveCount(1);
      await expect.poll(() => liveBoardTerminals(page)).toBe(1);

      // Forget it from the picker's recents: the confirm opens over the picker.
      await page.locator('[data-rail-open-project]').click();
      const row = picker.locator('[data-library-entry="weather-bot"]');
      await row.hover();
      await row.locator('[data-library-forget="weather-bot"]').click();
      await expect(confirm.getByRole('heading', { name: 'Forget weather-bot?' })).toBeVisible();
      await confirm.locator('[data-close-confirm]').click();
      await expect(confirm).toHaveCount(0);
      // Still in the picker, no longer recent.
      await expect(row).toBeVisible();
      await expect(row.locator('time')).toHaveCount(0);
      await expect(row.locator('[data-library-forget]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
      await expect(pod).toHaveCount(0);
      await expect(rail.getByRole('link', { name: /weather-bot/ })).toHaveCount(0);
      await expect.poll(() => liveBoardTerminals(page), { timeout: 8_000 }).toBe(0);
    } finally {
      await context.close();
    }
  });
});

const { defaultBrowserType: _ios, ...iPhone } = devices['iPhone 13'];

/** A real touch swipe across `x0 → x1` at height `y` (CDP touch events, as a finger sends). */
async function swipe(page: Page, y: number, x0: number, x1: number) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 6;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('on a phone', () => {
  test.use({ ...iPhone, viewport: { width: 390, height: 844 } });

  test('closes a project by swiping its row, and forgets one from its workspace', async ({
    browser,
  }) => {
    test.slow();
    const context = await browser.newContext({
      ...iPhone,
      viewport: { width: 390, height: 844 },
      baseURL: board.url,
      storageState: signedInState(board.url, board.session),
    });
    try {
      const page = await context.newPage();
      await page.goto('/#/projects');
      const rows = page.locator('[data-phone-project-row]');
      await expect(rows.first()).toBeVisible();
      const before = await rows.count();
      const first = rows.first();
      const projectId = (await first.getAttribute('data-phone-project-row')) ?? '';
      const name =
        (await first.locator('[data-phone-project] span[title]').first().textContent()) ?? '';

      // Swipe left: Close shows; a tap opens the confirm as a bottom sheet.
      const box = await first.boundingBox();
      if (!box) throw new Error('no row');
      const close = page.locator(`[data-phone-close="${projectId}"]`);
      await swipe(page, box.y + box.height / 2, box.x + box.width - 40, box.x + 60);
      await expect
        .poll(async () => (await first.locator('[data-phone-project]').boundingBox())?.x ?? 0)
        .toBeLessThan(-40);
      await close.tap();
      const confirm = page.locator(`[data-close-project="${projectId}"]`);
      await expect(confirm).toBeVisible();
      await expect(confirm.locator('[data-sheet-handle]')).toBeVisible();
      await expect(confirm.getByRole('heading', { name: `Close ${name}?` })).toBeVisible();
      await confirm.locator('[data-close-confirm]').tap();
      await expect(confirm).toHaveCount(0);
      await expect(page.locator(`[data-phone-project-row="${projectId}"]`)).toHaveCount(0);
      await expect(rows).toHaveCount(before - 1);
      await page.goto('/#/');
      await expect(page.locator('[data-pod]').first()).toBeVisible();
      await expect(page.locator(`[data-pod="${projectId}"]`)).toHaveCount(0);

      // Forget the next one from its workspace's overflow menu.
      await page.goto('/#/projects');
      const next = rows.first();
      const nextId = (await next.getAttribute('data-phone-project-row')) ?? '';
      await next.locator('[data-phone-project]').tap();
      await expect(page).toHaveURL(new RegExp(`#/p/${nextId}`));
      await page.locator('[data-workspace-menu-trigger]').tap();
      await page
        .locator('[data-workspace-menu]')
        .getByRole('button', { name: 'Forget project…' })
        .tap();
      const forget = page.locator(`[data-close-project="${nextId}"]`);
      await expect(forget).toBeVisible();
      await forget.locator('[data-close-confirm]').tap();
      await expect(forget).toHaveCount(0);
      await expect(page).toHaveURL(/#\/$/);
      await page.goto('/#/projects');
      await expect(rows.first()).toBeVisible();
      await expect(page.locator(`[data-phone-project-row="${nextId}"]`)).toHaveCount(0);
      await expect(rows).toHaveCount(before - 2);
    } finally {
      await context.close();
    }
  });
});

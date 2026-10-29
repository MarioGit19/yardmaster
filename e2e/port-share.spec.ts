import { devices, type Page } from '@playwright/test';
import { type DemoBoard, startDemoBoard } from './board.js';
import { expect, sessionHeader, signedInState, test } from './fixtures.js';

// 12.6e2: dev servers on the phone. The demo simulates Tailscale (`demo-mac.tailnet-demo.ts.net`),
// on its own board so the shared ports never show up in other specs' screenshots.

const HOST = 'demo-mac.tailnet-demo.ts.net';
const PORT = 3000;
const URL_3000 = `https://${HOST}:${PORT}`;

// One board, one test at a time: both share ports on it.
test.describe.configure({ mode: 'default' });

let board: DemoBoard;

test.beforeAll(async () => {
  board = await startDemoBoard();
});

test.afterAll(async () => {
  await board?.stop();
});

/** The terminal and project behind a listening port, from the board's snapshot. */
async function portOwner(
  page: Page,
  port: number,
): Promise<{ projectId: string; terminalId: string }> {
  const owner = await page.evaluate(async (wanted) => {
    const session = localStorage.getItem('yardmaster.session');
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/ui`, [
      'yardmaster',
      `yardmaster.session.${session}`,
    ]);
    const snapshot = await new Promise<{
      ports: Record<string, { port: number; terminalId: string | null; projectId: string | null }>;
    }>((resolve) => {
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === 'snapshot') resolve(message.payload.state);
      };
    });
    ws.close();
    const binding = Object.values(snapshot.ports).find((p) => p.port === wanted);
    return binding?.terminalId && binding.projectId
      ? { projectId: binding.projectId, terminalId: binding.terminalId }
      : null;
  }, port);
  if (!owner) throw new Error(`nothing listens on :${port} in the demo`);
  return owner;
}

async function sharedPorts(page: Page): Promise<number[]> {
  const res = await page.request.get('/api/ports/shares', {
    headers: sessionHeader(board.session),
  });
  const body = (await res.json()) as {
    available: boolean;
    shares: { port: number; mine: boolean }[];
  };
  expect(body.available).toBe(true);
  return body.shares.filter((s) => s.mine).map((s) => s.port);
}

test.describe('on a desktop', () => {
  test('shares a dev server, shows its tailnet link and the on-phone mark, then stops', async ({
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
      const chip = page.locator(`[data-pod] [data-port="${PORT}"]`).first();
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await expect(chip).not.toHaveAttribute('data-port-shared');

      // The chip's menu: copy, or open on the phone.
      await chip.click();
      const menu = page.locator(`[data-port-menu="${PORT}"]`);
      await expect(menu.getByRole('button', { name: `Copy localhost:${PORT}` })).toBeVisible();
      await menu.locator(`[data-open-on-phone="${PORT}"]`).click();

      const sheet = page.locator(`[data-port-share="${PORT}"]`);
      await expect(sheet.locator('[data-port-share-url]')).toHaveText(URL_3000);
      await expect(sheet.getByRole('img', { name: `QR code for ${URL_3000}` })).toBeVisible();
      await expect(sheet).toContainText('tailnet only');
      await expect(sheet.getByRole('link', { name: 'Open' })).toHaveAttribute('href', URL_3000);
      await expect(sheet.locator('[data-port-hint="other-ports"]')).toContainText(HOST);
      expect(await sharedPorts(page)).toEqual([PORT]);
      await sheet.getByRole('button', { name: 'Done' }).click();
      await expect(sheet).toHaveCount(0);

      // The mark, on the lane and in the focus view.
      await expect(chip).toHaveAttribute('data-port-shared', '');
      await expect(chip.locator('[data-on-phone]')).toBeVisible();
      const { projectId, terminalId } = await portOwner(page, PORT);
      await page.goto(`/#/p/${projectId}/t/${terminalId}`);
      const focusChip = page.locator(`[data-focus-port] [data-port="${PORT}"]`);
      await expect(focusChip).toHaveAttribute('data-port-shared', '');

      // Stop sharing from the chip.
      await focusChip.click();
      await page
        .locator(`[data-port-menu="${PORT}"]`)
        .getByRole('button', { name: 'Stop sharing' })
        .click();
      await expect(focusChip).not.toHaveAttribute('data-port-shared');
      expect(await sharedPorts(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

const { defaultBrowserType: _android, ...galaxy } = devices['Galaxy S24'];

test.describe('on a phone', () => {
  test('shares a dev server from the workspace in a bottom sheet', async ({ browser }) => {
    test.slow();
    const context = await browser.newContext({
      ...galaxy,
      viewport: { width: 412, height: 915 },
      baseURL: board.url,
      storageState: signedInState(board.url, board.session),
    });
    try {
      const page = await context.newPage();
      await page.goto('/#/projects');
      await expect(page.locator('[data-phone-shell][data-hydrated]')).toBeAttached();
      const { projectId, terminalId } = await portOwner(page, PORT);
      await page.goto(`/#/p/${projectId}/t/${terminalId}`);
      await expect(
        page.locator(`[data-focus="${projectId}"][data-workspace="phone"]`),
      ).toBeVisible();

      const chip = page.locator(`[data-focus-port] [data-port="${PORT}"]`);
      await chip.tap();
      await page.locator(`[data-port-menu="${PORT}"] [data-open-on-phone="${PORT}"]`).tap();
      const sheet = page.locator(`[data-port-share="${PORT}"][data-sheet]`);
      await expect(sheet.locator('[data-port-share-url]')).toHaveText(URL_3000);
      // The QR code is for the Mac's screen; a phone gets Copy and Open.
      await expect(sheet.locator('[data-qr]')).toHaveCount(0);
      await expect(sheet.getByRole('button', { name: 'Copy' })).toBeVisible();
      await sheet.getByRole('button', { name: 'Done' }).tap();
      await expect(chip).toHaveAttribute('data-port-shared', '');
      await expect(chip.locator('[data-on-phone]')).toBeVisible();
      expect(await sharedPorts(page)).toEqual([PORT]);

      // No sideways scroll with the sheet's content on a phone.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
});

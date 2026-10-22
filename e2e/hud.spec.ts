import { startDemoBoard } from './board.js';
import { expect, openRoute, signedInState, test } from './fixtures.js';

test('the HUD counters roll when the demo changes', async ({ page }) => {
  test.slow();
  await openRoute(page, '/');
  const hud = page.locator('header').first();
  await expect(hud.locator('[data-counter="Working"]')).toBeVisible();
  // Collects every transform each digit strip passes through until one strip has rolled
  // through intermediate positions, i.e. animated rather than jumped.
  const frames = await hud.evaluate(
    (header) =>
      new Promise<number>((resolve, reject) => {
        const seen = new Map<Element, Set<string>>();
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const el = record.target as HTMLElement;
            if (!el.closest('[data-counter]')) continue;
            const values = seen.get(el) ?? new Set<string>();
            values.add(el.style.transform);
            seen.set(el, values);
            if (values.size >= 4) {
              observer.disconnect();
              resolve(values.size);
            }
          }
        });
        observer.observe(header, { subtree: true, attributes: true, attributeFilter: ['style'] });
        setTimeout(() => {
          observer.disconnect();
          reject(new Error('no counter rolled within 40 s'));
        }, 40_000);
      }),
  );
  expect(frames).toBeGreaterThanOrEqual(4);
});

test('the Waiting count opens the Attention Center', async ({ page }) => {
  test.slow();
  await openRoute(page, '/');
  const waiting = page.locator('[data-hud="waiting"]');
  // The demo's first permission request arrives 8–14 s in.
  await expect(waiting.locator('[data-value]')).not.toHaveAttribute('data-value', '0', {
    timeout: 30_000,
  });
  await waiting.click();
  const sheet = page.getByRole('complementary', { name: /Needs you/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-waiting]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('killing the server shows the disconnected state', async ({ browser }) => {
  test.slow();
  const board = await startDemoBoard();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
  });
  try {
    const page = await context.newPage();
    await openRoute(page, '/');
    const connection = page.locator('header [data-connection]');
    await expect(connection).toHaveAttribute('data-connection', 'live');
    await expect(connection).toContainText('Live');

    await board.stop();
    await expect(connection).toHaveAttribute('data-connection', 'reconnecting');
    await expect(connection).toContainText('Reconnecting…');
    await expect(connection.locator('.hud-spin')).toBeVisible();
    await expect(page.locator('div[role="status"]', { hasText: 'Reconnecting…' })).toBeVisible();
    await expect(page.locator('main')).toHaveCSS('opacity', '0.6');
  } finally {
    await context.close();
    await board.stop();
  }
});

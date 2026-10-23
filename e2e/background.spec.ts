import { expect, openRoute, test } from './fixtures.js';

// The demo's acme-shop Claude keeps a background shell ("Typecheck watcher") and, every other
// round, an async subagent going: each runs 9–14 s and starts again after a short pause.

const POD = '[data-pod]';

test.describe('background work', () => {
  test('a session row shows its background work and the focus view lists it to the end', async ({
    page,
  }) => {
    test.slow();
    await openRoute(page, '/');
    const pod = page.locator(POD, { hasText: 'acme-shop' });
    const line = pod.locator('[data-background-line]');
    await expect(line).toContainText(/\d+ running: .*Typecheck watcher/, { timeout: 30_000 });
    await expect(line.locator('.hud-spin')).toHaveCount(1);
    const sessionId = await line.getAttribute('data-background-line');

    await line.click();
    await expect(page).toHaveURL(new RegExp(`/s/${sessionId}$`));
    const panel = page.locator(`[data-background-panel="${sessionId}"]`);
    const list = panel.locator('[data-background-list]');
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('[data-background-toggle]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const running = list.locator('[data-background-item][data-status="running"]');
    await expect(running.first()).toBeVisible();
    // Elapsed time ticks while it runs.
    const elapsed = running.first().locator('.tabular').first();
    const before = await elapsed.textContent();
    await expect(elapsed).not.toHaveText(before ?? '', { timeout: 5_000 });

    // A run finishes and stays listed with its outcome, in text.
    const finished = list.locator(
      '[data-background-item]:is([data-status="done"], [data-status="error"])',
    );
    await expect(finished.first()).toBeVisible({ timeout: 30_000 });
    await expect(finished.first()).toContainText(/Done|Exit \d+/);
    await expect(panel.locator('[data-background-summary]')).toContainText('finished');

    // The focus view's row has the same line; the toggle closes the list.
    await expect(page.locator(`[data-focus] [data-background-line="${sessionId}"]`)).toHaveCount(
      1,
      {
        timeout: 30_000,
      },
    );
    await panel.locator('[data-background-toggle]').click();
    await expect(list).toHaveCount(0);
  });

  test.describe('narrow', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('the line in the Sessions tab opens the list in the Claude tab', async ({ page }) => {
      test.slow();
      await openRoute(page, '/');
      await page.locator('a[href^="#/p/"]', { hasText: 'acme-shop' }).first().click();
      await page.getByRole('tab', { name: 'Sessions' }).click();
      const line = page.locator('[data-focus] [data-background-line]').first();
      await expect(line).toBeVisible({ timeout: 30_000 });
      const sessionId = await line.getAttribute('data-background-line');
      await line.click();
      await expect(page.getByRole('tab', { name: 'Claude' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(
        page.locator(`[data-background-panel="${sessionId}"] [data-background-list]`),
      ).toBeVisible({ timeout: 15_000 });
    });
  });
});

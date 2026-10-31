import type { Page } from '@playwright/test';
import { expect, openRoute, test } from './fixtures.js';

/** Comes back as if the board had been left half an hour ago, and something waits by now. */
async function comeBack(page: Page) {
  await expect(page.locator('[data-strip-item]').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    localStorage.setItem('yardmaster.recap.lastActive', String(Date.now() - 30 * 60_000));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const recap = page.locator('[data-recap]');
  await expect(recap).toBeVisible();
  return recap;
}

test.describe('while you were away', () => {
  test('shows nothing to someone who never left', async ({ page }) => {
    await openRoute(page, '/');
    await page.waitForTimeout(1_000);
    await expect(page.locator('[data-recap]')).toHaveCount(0);
  });

  test('lists what happened in order, and an item opens and closes it', async ({ page }) => {
    await openRoute(page, '/');
    const recap = await comeBack(page);
    const sections = await recap
      .locator('[data-recap-section]')
      .evaluateAll((all) => all.map((el) => el.getAttribute('data-recap-section')));
    const order = ['needs_you', 'failed', 'finished', 'running'];
    expect(sections.length).toBeGreaterThan(0);
    expect(sections).toEqual(order.filter((name) => sections.includes(name)));
    await expect(page.getByRole('heading', { name: 'While you were away' })).toBeVisible();
    await recap.locator('a[data-recap-item]').first().click();
    await expect(recap).toHaveCount(0);
    await expect(page).toHaveURL(/#\/p\//);
  });

  test('takes no focus, and Esc dismisses it without touching what needs you', async ({ page }) => {
    await openRoute(page, '/');
    const before = await page.evaluate(() => document.activeElement?.tagName);
    const recap = await comeBack(page);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(before);
    const strip = page.locator('[data-needs-you]');
    await page.keyboard.press('Escape');
    await expect(recap).toHaveCount(0);
    await expect(strip.locator('[data-strip-item]').first()).toBeVisible();
  });

  test('Mark all seen can be undone and leaves what needs you', async ({ page }) => {
    await openRoute(page, '/');
    test.setTimeout(120_000);
    await expect(page.locator('[data-strip-item]').first()).toBeVisible({ timeout: 30_000 });
    const dots = page.locator('main [data-status="ok"]');
    await expect(dots.first()).toBeVisible({ timeout: 90_000 });
    const recap = await comeBack(page);
    const seenPost = (key: 'marks' | 'restore') =>
      page.waitForRequest((request) => {
        if (!request.url().endsWith('/api/seen') || request.method() !== 'POST') return false;
        return Object.keys(request.postDataJSON()?.[key] ?? {}).length > 0;
      });
    const marked = seenPost('marks');
    await recap.locator('[data-recap-mark-all]').click();
    await expect(recap).toHaveCount(0);
    await marked;
    await expect(page.locator('[data-strip-item]').first()).toBeVisible();
    const restored = seenPost('restore');
    await page.locator('[data-sonner-toast] button[data-action]', { hasText: 'Undo' }).click();
    await restored;
    await expect(dots.first()).toBeVisible();
  });

  test('the setting turns it off', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('yardmaster.recap.after', 'off'));
    await openRoute(page, '/');
    await expect(page.locator('[data-strip-item]').first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => {
      localStorage.setItem('yardmaster.recap.lastActive', String(Date.now() - 30 * 60_000));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1_000);
    await expect(page.locator('[data-recap]')).toHaveCount(0);
  });

  test('on a phone it greets the app opening, as a sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Set during the load: leaving a page saves its real last activity.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('reopened')) return;
      localStorage.setItem('yardmaster.recap.lastActive', String(Date.now() - 30 * 60_000));
    });
    await openRoute(page, '/');
    await expect(page.locator('[data-strip-item]').first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => sessionStorage.setItem('reopened', '1'));
    await page.reload();
    const recap = page.locator('[data-recap]');
    await expect(recap).toBeVisible();
    await expect(recap.locator('[data-sheet-handle]')).toBeVisible();
    await recap.locator('[data-recap-dismiss]').click();
    await expect(recap).toHaveCount(0);
  });
});

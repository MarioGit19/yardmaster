import { expect, openRoute, test } from './fixtures.js';

const pods = '[data-pod]';

test('the density setting changes what a card shows, and stays after a reload', async ({
  page,
}) => {
  await openRoute(page, '/settings');
  await page.locator('[data-setting="density"]').getByRole('button', { name: 'List' }).click();
  await openRoute(page, '/');
  await expect(page.locator(pods).first()).toBeVisible();
  await expect(page.locator('[data-pod-form="card"]')).toHaveCount(0);
  await expect(page.locator('[data-session]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator(pods).first()).toBeVisible();
  await expect(page.locator('[data-pod-form="card"]')).toHaveCount(0);
  const heights = await page
    .locator(pods)
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBeLessThan(56);
});

test('Compact is one palette search away and drops the crew and graphs', async ({ page }) => {
  await openRoute(page, '/');
  await expect(page.locator('[data-pod] header [data-crew]').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('density compact');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-density="compact"]')).toBeVisible();
  await expect(page.locator('[data-pod] header [data-crew]')).toHaveCount(0);
  await expect(page.locator('[data-session-meta]')).toHaveCount(0);
  await expect(page.locator('.lane-signal-graph:visible')).toHaveCount(0);
});

test('a pod keeps its place when the density changes', async ({ page }) => {
  await openRoute(page, '/');
  await expect(page.locator(pods).first()).toBeVisible();
  const ids = () =>
    page.locator(pods).evaluateAll((els) => els.map((el) => el.getAttribute('data-pod')));
  const before = await ids();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('density list');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-density="list"]')).toBeVisible();
  expect((await ids()).slice(0, before.length)).toEqual(before);
});

test('a line opens the focus view', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yardmaster.density', 'list'));
  await openRoute(page, '/');
  await page.locator('[data-pod-form="row"] a').first().click();
  await expect(page.locator('[data-focus]')).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the Projects list follows the density without sideways scroll', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('yardmaster.density', 'list'));
    await openRoute(page, '/projects');
    await expect(page.locator('[data-phone-project]').first()).toBeVisible();
    await expect(page.locator('[data-phone-project][data-pod-form="card"]')).toHaveCount(0);
    await expect(page.locator('[data-phone-lead]')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

import { expect, openRoute, test } from './fixtures.js';

// The fx effects (apps/web/src/fx) on /_tokens and the ambient style setting.
test.use({ viewport: { width: 1440, height: 900 } });

const section = (page: import('@playwright/test').Page, name: string) =>
  page.locator('section', { has: page.getByRole('heading', { name }) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'full'));
});

test('a WebGL background replaces the ambient field while it is on screen', async ({ page }) => {
  await page.goto('/#/_tokens');
  const field = page.locator('[data-ambient]');
  await expect(field).toHaveAttribute('data-ambient', 'webgl');

  const backgrounds = section(page, 'Backgrounds');
  await backgrounds.scrollIntoViewIfNeeded();
  await expect(backgrounds.locator('[data-fx-stage="webgl"] canvas[data-ready]')).toBeAttached();
  await expect(field).toHaveAttribute('data-ambient', 'css');
  await expect(field.locator('canvas')).toHaveCount(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(backgrounds.locator('[data-fx-stage]')).toHaveCount(0);
  await expect(field).toHaveAttribute('data-ambient', 'webgl');
});

test('Settings switches the ambient style and remembers it', async ({ page }) => {
  await openRoute(page, '/settings');
  const field = page.locator('[data-ambient]');
  await expect(field).toHaveAttribute('data-ambient-style', 'nebula');
  const ambient = page.getByRole('group', { name: 'Ambient' });
  await ambient.getByRole('button', { name: 'Aurora' }).click();
  await expect(field).toHaveAttribute('data-ambient-style', 'aurora');
  await expect(field).toHaveAttribute('data-ambient', 'webgl');
  await ambient.getByRole('button', { name: 'None' }).click();
  await expect(field).toHaveAttribute('data-ambient', 'none');
  await page.reload();
  await expect(page.locator('[data-ambient]')).toHaveAttribute('data-ambient', 'none');
});

test('swiping an approval past the threshold allows it', async ({ page }) => {
  await page.goto('/#/_tokens');
  const phone = section(page, 'Phone interactions');
  await phone.scrollIntoViewIfNeeded();
  const card = phone.getByText('pnpm db:migrate');
  const box = await card.boundingBox();
  if (!box) throw new Error('no approval card');
  const y = box.y + box.height / 2;

  // A short drag springs back.
  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, y, { steps: 6 });
  await page.mouse.up();
  await expect(phone.getByText('Allowed')).toHaveCount(0);

  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, y, { steps: 12 });
  await page.mouse.up();
  await expect(phone.getByText('Allowed', { exact: true })).toBeVisible();
});

test('a hold button fires only after a full hold', async ({ page }) => {
  await page.goto('/#/_tokens');
  const phone = section(page, 'Phone interactions');
  await phone.scrollIntoViewIfNeeded();
  const hold = phone.getByRole('button', { name: /Hold to stop/ });

  await hold.hover();
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await expect(phone.getByText('stopped 0×')).toBeVisible();

  await page.mouse.down();
  await page.waitForTimeout(1500);
  await page.mouse.up();
  // The phase itself resets after 1.6 s, so the count is the stable proof.
  await expect(phone.getByText('stopped 1×')).toBeVisible();
});

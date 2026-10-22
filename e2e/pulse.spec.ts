import { expect, openRoute, test } from './fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('the Pulse rail renders demo activity, filters it, and navigates on click', async ({
  page,
}) => {
  await openRoute(page, '/');
  const rail = page.locator('[data-pulse]');
  await expect(rail).toHaveAttribute('data-pulse', 'expanded');
  const canvas = rail.locator('canvas[data-pulse-canvas]');
  // Six demo projects, each with a lane and backfilled events.
  await expect(canvas).toHaveAttribute('data-lanes', '6');
  await expect.poll(async () => Number(await canvas.getAttribute('data-dots'))).toBeGreaterThan(20);

  // Filters narrow the dots; Errors shows only failures.
  const all = Number(await canvas.getAttribute('data-dots'));
  await rail.locator('[data-filter="terminals"]').click();
  await expect(rail.locator('[data-filter="terminals"]')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => Number(await canvas.getAttribute('data-dots'))).toBeLessThan(all);
  await rail.locator('[data-filter="all"]').click();

  // The keyboard picks the newest dot and shows its tooltip at the dot.
  const plot = rail.getByRole('application');
  await plot.focus();
  await page.keyboard.press('End');
  const tooltip = rail.locator('[data-pulse-tooltip]');
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();

  // Pick an older dot (it won't drift out from under the pointer) and click it.
  await page.keyboard.press('Home');
  await expect(tooltip).toBeVisible();
  const x = Number(await tooltip.getAttribute('data-x'));
  const y = Number(await tooltip.getAttribute('data-y'));
  await plot.blur();
  await canvas.hover({ position: { x, y } });
  await expect(tooltip).toBeVisible();
  await canvas.click({ position: { x, y } });
  await expect(page).toHaveURL(/#\/p\/[^/]+/);
  await expect(page.locator('[data-focus]')).toBeVisible();
});

test('the Pulse rail collapses and remembers it', async ({ page }) => {
  await openRoute(page, '/');
  const rail = page.locator('[data-pulse]');
  await rail.getByRole('button', { name: /Pulse/ }).click();
  await expect(rail).toHaveAttribute('data-pulse', 'collapsed');
  await expect(rail.locator('canvas')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-pulse]')).toHaveAttribute('data-pulse', 'collapsed');
});

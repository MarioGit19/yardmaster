import { expect, openRoute, test } from './fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('the Pulse rail renders demo activity, filters it, and navigates on click', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('yardmaster.pulse', 'expanded'));
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

  // Pick a dot a few steps back from the newest: past its fly-in, and nowhere near the oldest,
  // which can age out of the 15-minute window before the pointer lands on it.
  await page.keyboard.press('End');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
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

test('the Pulse rail starts collapsed on a short screen and expanded on a tall one', async ({
  page,
}) => {
  await openRoute(page, '/');
  const rail = page.locator('[data-pulse]');
  await expect(rail).toHaveAttribute('data-pulse', 'collapsed');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect(rail).toHaveAttribute('data-pulse', 'expanded');
});

test('the Pulse rail collapses and remembers it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openRoute(page, '/');
  const rail = page.locator('[data-pulse]');
  await expect(rail).toHaveAttribute('data-pulse', 'expanded');
  await rail.getByRole('button', { name: /Pulse/ }).click();
  await expect(rail).toHaveAttribute('data-pulse', 'collapsed');
  await expect(rail.locator('canvas')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-pulse]')).toHaveAttribute('data-pulse', 'collapsed');
});

test('the collapsed Pulse rail sends a runner along its hairline per new event', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('yardmaster.pulse', 'collapsed');
    localStorage.setItem('yardmaster.motion', 'full');
  });
  await openRoute(page, '/');
  const ticker = page.locator('[data-pulse="collapsed"] [data-pulse-ticker]');
  await expect(ticker).toBeAttached();
  // The demo raises events every few seconds; each one launches a runner.
  await expect
    .poll(async () => Number((await ticker.getAttribute('data-runs')) ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(0);
});

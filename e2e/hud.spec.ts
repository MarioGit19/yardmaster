import { startDemoBoard } from './board.js';
import { expect, openRoute, signedInState, test } from './fixtures.js';

test('the HUD counters roll when the demo changes', async ({ page }) => {
  test.slow();
  await openRoute(page, '/');
  const hud = page.locator('header').first();
  await expect(hud.locator('[data-counter="Active"]')).toBeVisible();
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

test('the Needs you count opens the Attention Center', async ({ page }) => {
  test.slow();
  await openRoute(page, '/');
  const waiting = page.locator('[data-hud="needs-you"]');
  // The demo's first permission request arrives 8–14 s in.
  await expect(waiting.locator('[data-value]')).not.toHaveAttribute('data-value', '0', {
    timeout: 30_000,
  });
  await waiting.click();
  const sheet = page.getByRole('complementary', { name: /Needs you/ });
  await expect(sheet).toBeVisible();
  const card = sheet.locator('article[data-approval]').first();
  await expect(card).toBeVisible();
  // Each request shows its payload (the command or the file).
  await expect(card.locator('[data-command], code, .diff').first()).not.toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // A click on the scrim beside the sheet closes it too.
  await waiting.click();
  await expect(sheet).toBeVisible();
  await page.locator('[data-attention-scrim]').click({ position: { x: 20, y: 200 } });
  await expect(sheet).toBeHidden();
});

// Full slides the sheet in, Reduced only fades it, Off shows it at once.
for (const level of ['full', 'reduced', 'off'] as const) {
  test(`the Attention Center at ${level} motion`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('yardmaster.motion', value), level);
    await openRoute(page, '/');
    const button = page.locator('[data-hud="needs-you"]');
    await expect(button).toBeVisible();
    // Samples the sheet's computed transform and opacity every frame once it appears.
    const sampling = page.evaluate(
      () =>
        new Promise<{ transform: string; opacity: number }[]>((resolve) => {
          const frames: { transform: string; opacity: number }[] = [];
          let start: number | null = null;
          const tick = (now: number) => {
            const sheet = document.querySelector('aside[aria-labelledby="attention-title"]');
            if (sheet) {
              start ??= now;
              const style = getComputedStyle(sheet);
              frames.push({ transform: style.transform, opacity: Number(style.opacity) });
            }
            if (start === null || now - start < 400) requestAnimationFrame(tick);
            else resolve(frames);
          };
          requestAnimationFrame(tick);
        }),
    );
    await button.click();
    const frames = await sampling;
    expect(frames.length).toBeGreaterThan(2);
    const moved = frames.some((f) => f.transform !== 'none');
    const faded = frames.some((f) => f.opacity < 1);
    expect(moved).toBe(level === 'full');
    if (level === 'off') expect(faded).toBe(false);
    else expect(faded).toBe(true);
    await expect(page.getByRole('complementary', { name: /Needs you/ })).toBeVisible();
  });
}

test('Failed and Active jump to what they count', async ({ page }) => {
  test.slow();
  await openRoute(page, '/');
  for (const name of ['failed', 'active']) {
    const counter = page.locator(`[data-hud="${name}"]`);
    await expect(counter.locator('[data-value]')).not.toHaveAttribute('data-value', '0', {
      timeout: 45_000,
    });
    await counter.click();
    const item = page.locator(`[data-hud-list="${name}"] a[data-hud-item]`).first();
    if (await item.isVisible()) await item.click();
    await expect(page.locator('[data-focus]')).toBeVisible();
    await page.goBack();
  }
});

test('killing the server shows the disconnected state', async ({ browser }) => {
  test.slow();
  const board = await startDemoBoard();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.session),
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

test('the usage chip shows both limits and warns at the threshold set in Settings', async ({
  page,
}) => {
  await openRoute(page, '/settings');
  const chip = page.locator('[data-hud="usage"]');
  await expect(chip.locator('[data-usage="fiveHour"]')).toContainText('5h');
  await expect(chip.locator('[data-usage="sevenDay"]')).toContainText('18%');
  await expect(chip).toHaveAttribute('aria-label', /5-hour \d+% used, resets at .*as of /);
  await expect(chip.locator('[data-usage="fiveHour"]')).not.toHaveAttribute('data-warn', 'true');

  await page
    .locator('[data-setting="usageWarnFiveHour"]')
    .getByRole('button', { name: '50%' })
    .click();
  await expect(chip.locator('[data-usage="fiveHour"]')).toHaveAttribute('data-warn', 'true');
});

test('the Settings row explains the chip, and it links there', async ({ page }) => {
  await openRoute(page, '/');
  await page.locator('[data-hud="usage"]').click();
  await expect(page.locator('[data-setting="usageWarnSevenDay"]')).toBeVisible();
});

import { expect, test } from './fixtures.js';
import { openLongTranscript } from './messages.js';

// One file, run in order in its own project before the parallel suite (see the config), so the
// long-task check has the machine to itself.
test.use({ viewport: { width: 1440, height: 900 } });

test('a 500+ message transcript scrolls without long tasks', async ({ page }) => {
  const list = await openLongTranscript(page);
  // Let the initial replay, measurement and highlighting settle.
  await page.waitForTimeout(1_500);

  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) w.__longTasks.push(entry.duration);
    }).observe({ type: 'longtask' });
  });

  // Wheel all the way to the top, as a reader would, then back down.
  await list.hover();
  const top = () => list.evaluate((el) => el.scrollTop);
  for (let i = 0; i < 400 && (await top()) > 0; i++) {
    await page.mouse.wheel(0, -1_200);
    await page.waitForTimeout(16);
  }
  expect(await top()).toBe(0);
  await expect(list.locator('[data-index="0"]')).toBeVisible();
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 2_400);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(300);

  const longTasks = await page.evaluate(
    () => (window as unknown as { __longTasks: number[] }).__longTasks,
  );
  console.log(
    `transcript scroll: ${longTasks.length} long tasks${longTasks.length ? `, worst ${Math.max(...longTasks).toFixed(0)} ms` : ''}`,
  );
  expect(longTasks).toEqual([]);
});

test('the transcript opens at the latest message and offers a jump back', async ({ page }) => {
  const list = await openLongTranscript(page);
  // Only a window of the 500+ rows is in the DOM.
  expect(await list.locator('[data-row]').count()).toBeLessThan(60);
  await expect(list).toHaveAttribute('data-at-end', '');

  const pill = page.getByRole('button', { name: /Jump to latest/ });
  await expect(pill).toHaveCount(0);
  await list.hover();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -800);
  await expect(pill).toBeVisible();
  await expect(list).not.toHaveAttribute('data-at-end', '');

  await pill.click();
  await expect(list).toHaveAttribute('data-at-end', '');
  await expect(pill).toHaveCount(0);
  const gap = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(gap).toBeLessThan(48);
});

test('a reader at the latest message follows new rows, also in front of the live caption', async ({
  page,
}) => {
  const list = await openLongTranscript(page);
  await expect(list).toHaveAttribute('data-at-end', '');
  // The demo session keeps working: rows land before its caption, which keeps the last key.
  for (let round = 0; round < 3; round++) {
    const count = Number(await list.getAttribute('data-count'));
    await expect
      .poll(async () => Number(await list.getAttribute('data-count')), { timeout: 20_000 })
      .toBeGreaterThan(count);
    await expect(list).toHaveAttribute('data-at-end', '');
    await expect
      .poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(48);
  }
});

test('renders user bubbles, markdown with highlighted code, and collapsible thinking', async ({
  page,
}) => {
  const list = await openLongTranscript(page);

  /** Scrolls up a screen at a time until `selector` is rendered in the list. */
  const scrollUntil = async (selector: string) => {
    for (let i = 0; i < 60 && (await list.locator(selector).count()) === 0; i++) {
      await list.evaluate((el) => el.scrollBy(0, -el.clientHeight));
      await page.waitForTimeout(60);
    }
    await expect(list.locator(selector).first()).toBeAttached();
  };

  // The latest screen may be all tool calls once the demo has run a while.
  await scrollUntil('[data-row="user"]');
  await expect(list.locator('[data-row="user"]').first()).toBeVisible();

  // The worker colors tokens with the token-mapped theme variables.
  await scrollUntil('.md-code');
  await expect(
    list.locator('.md-code pre[data-highlighted] span[style*="--shiki-"]').first(),
  ).toBeAttached();

  await scrollUntil('[data-row="thinking"]');
  // By index: rows are append-only, so an index keeps naming the same row as messages arrive.
  const index = await list.locator('[data-row="thinking"]').first().getAttribute('data-index');
  const row = list.locator(`[data-index="${index}"]`);
  const toggle = row.locator('button[aria-expanded]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('[id]').last()).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

import type { Locator, Page } from '@playwright/test';
import { expect, openRoute } from './fixtures.js';

/** The demo gives its first project's first session a 500+ message history. */
export const LONG_PROJECT = 'acme-shop';

/** Opens the long-history project's chat and waits for the full transcript. */
export async function openLongTranscript(page: Page) {
  await openRoute(page, '/');
  const link = page.locator('a[href^="#/p/"]', { hasText: LONG_PROJECT }).first();
  const href = await link.getAttribute('href');
  if (!href) throw new Error(`${LONG_PROJECT} is not in the rail`);
  await openRoute(page, href.slice(1));
  // A phone opens the project hub: the session's card opens its chat.
  await page.locator('[data-hub], [data-message-list]').first().waitFor();
  const hub = page.locator('[data-hub]');
  if (await hub.isVisible()) await hub.locator('[data-hub-kind="session"]').first().click();
  const list = page.locator('[data-message-list]');
  await expect(list).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => Number(await list.getAttribute('data-count')), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(500);
  return list;
}

/** Scrolls the transcript up until a turn header (`data-turn`, Retro's `── YOU ──`) is in view. */
export async function scrollToTurnHead(list: Locator) {
  await expect
    .poll(
      async () => {
        const seen = await list.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return [...el.querySelectorAll('[data-turn]')].some((head) => {
            const r = head.getBoundingClientRect();
            return r.top >= box.top && r.top < box.top + box.height * 0.6;
          });
        });
        if (!seen) await list.evaluate((el) => el.scrollBy(0, -240));
        return seen;
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
}

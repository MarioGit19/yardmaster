import { expect, openRoute, test } from './fixtures.js';

declare global {
  interface Window {
    __favicons: { state: string; href: string; title: string }[];
  }
}

test('the live favicon and title follow the demo board', async ({ page }) => {
  // The demo raises its first permission request within ~15 s of boot, and repeats.
  test.setTimeout(90_000);
  // Record every favicon change, so a short-lived state can't slip between polls.
  await page.addInitScript(() => {
    window.__favicons = [];
    new MutationObserver(() => {
      const link = document.querySelector<HTMLLinkElement>('link#live-favicon');
      const last = window.__favicons.at(-1);
      if (!link || (last?.href === link.href && last.title === document.title)) return;
      window.__favicons.push({
        state: link.dataset.state ?? '',
        href: link.href,
        title: document.title,
      });
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await openRoute(page, '/');

  const icon = page.locator('link#live-favicon');
  await expect(icon).toHaveAttribute('type', 'image/svg+xml');
  await expect(icon).toHaveAttribute('href', /^data:image\/svg\+xml,/);

  await expect
    .poll(() => page.evaluate(() => window.__favicons.some((f) => f.state === 'wait')), {
      timeout: 75_000,
    })
    .toBe(true);

  const changes = await page.evaluate(() => window.__favicons);
  expect(new Set(changes.map((f) => f.href)).size).toBeGreaterThan(1);
  for (const change of changes) {
    expect(change.title).toMatch(change.state === 'wait' ? /^\(\d+\) c-board$/ : /^c-board$/);
  }
});

import type { Page } from '@playwright/test';
import { expect, openRoute, test } from './fixtures.js';

// docs-site's board session starts `interrupted`, as if the server had restarted mid-turn
// (demo/content.ts). The restart itself is covered by the server tests (app.test.ts).
async function openDocsSite(page: Page) {
  await openRoute(page, '/');
  const href = await page
    .locator('a[href^="#/p/"]', { hasText: 'docs-site' })
    .first()
    .getAttribute('href');
  if (!href) throw new Error('no docs-site project');
  await openRoute(page, href.slice(1));
}

test.use({ viewport: { width: 1440, height: 900 } });

test('an interrupted board session resumes from its row and takes a reply', async ({ page }) => {
  test.slow();
  await openDocsSite(page);
  const row = page.locator('[data-focus] a[data-session]', { hasText: 'Interrupted' });
  await expect(row).toHaveCount(1);
  const sessionId = await row.getAttribute('data-session');
  await row.click();

  const panel = page.locator(`[data-session-panel="${sessionId}"]`);
  const bar = panel.locator('[data-resume-bar]');
  await expect(bar).toContainText('Interrupted by a board restart');
  // Its transcript is there, and nothing was re-sent.
  const list = panel.locator('[data-message-list]');
  await expect(list.locator('[data-row]').first()).toBeVisible();
  await expect(panel.locator('form[data-composer]')).toHaveCount(0);

  await page.locator(`[data-focus] [data-row-resume]`).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('[data-focus] header').first()).toContainText('Idle');
  await expect(page.locator(`[data-focus] a[data-session="${sessionId}"]`)).not.toContainText(
    'Interrupted',
  );

  // The crew member resting under the last message isn't a message.
  const resting = await list.locator('[data-row="rest"]').count();
  const before = Number(await list.getAttribute('data-count')) - resting;
  const reply = panel.getByRole('textbox', { name: /^Message / });
  await reply.fill('Carry on where you stopped.');
  await reply.press('Enter');
  await expect(list.locator('[data-row="user"]').last()).toContainText(
    'Carry on where you stopped.',
  );
  expect(Number(await list.getAttribute('data-count'))).toBeGreaterThan(before);
  await expect(list.locator('[data-row="tail"]')).toBeVisible({
    timeout: 15_000,
  });
  // The same session carried on: no new route.
  await expect(page).toHaveURL(new RegExp(`/s/${sessionId}$`));
});

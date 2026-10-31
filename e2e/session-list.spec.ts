import { expect, openRoute, test } from './fixtures.js';

const FINISHED = '00000000-0000-4000-8000-00000000f1d0';

test.use({ viewport: { width: 1440, height: 900 } });

async function openLedger(page: import('@playwright/test').Page) {
  await openRoute(page, '/');
  await page.locator('a[href^="#/p/"]', { hasText: 'ledger-sync' }).first().click();
  await expect(page.locator('[data-focus]')).toHaveCount(1);
}

test('a finished session archives to History, and Undo brings it back', async ({ page }) => {
  await openLedger(page);
  const row = page.locator(`[data-session-list] a[data-session="${FINISHED}"]`);
  // Its generated title is its name.
  await expect(row.locator('[data-session-name]')).toHaveText('Retry queue cleanup');

  await page.locator(`[data-session-list] [data-archive-session="${FINISHED}"]`).click();
  await expect(row).toHaveCount(0);
  const history = page.locator(`[data-history="${FINISHED}"]`);
  await expect(history.locator('[data-history-archived]')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row).toHaveCount(1);
  await expect(history).toHaveCount(0);
});

test('a terminal session gets a board-side name, and says so', async ({ page }) => {
  await openLedger(page);
  await page.locator(`a[data-session="${FINISHED}"]`).click();
  await page.locator('[data-session-panel] [data-rename-session]').click();
  const popover = page.locator('[data-rename-popover]');
  await expect(popover.locator('[data-rename-hint]')).toContainText('this board only');

  await popover.getByLabel('Session name').fill('Queue audit');
  await popover.getByLabel('Session name').press('Enter');
  const name = page.locator('[data-session-panel] h2');
  await expect(name).toHaveText('Queue audit');

  // Clearing the board name brings the generated title back.
  await page.locator('[data-session-panel] [data-rename-session]').click();
  await popover.getByLabel('Session name').fill('');
  await popover.getByLabel('Session name').press('Enter');
  await expect(name).toHaveText('Retry queue cleanup');
});

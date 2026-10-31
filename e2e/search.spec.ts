import { expect, openRoute, test } from './fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

/** Words from the demo's seeded follow-ups, spoken in many sessions. */
const WORDS = 'lookup table';

test('⌘K hands typed words to a search, and a result opens the transcript there', async ({
  page,
}) => {
  await openRoute(page, '/');
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill(WORDS);
  const command = palette.locator('[data-command="search-history-for"]');
  await expect(command).toContainText(`Search history for “${WORDS}”`);
  await command.click();

  await expect(page).toHaveURL(/#\/search$/);
  await expect(page.locator('[data-search-input]')).toHaveValue(WORDS);
  const hit = page.locator('[data-search-hit]').first();
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark').first()).toHaveText(/lookup|table/i);

  await hit.click();
  await expect(page).toHaveURL(/#\/search\/[^/]+\/[^/]+$/);
  const target = page.locator('[data-jump-target]');
  await expect(target).toContainText(/lookup table/i);
  await expect(target).toBeInViewport();

  await page.getByRole('link', { name: 'Search' }).click();
  await expect(page.locator('[data-screen=""] [data-search-input]')).toHaveValue(WORDS);
});

test('the filters narrow the results', async ({ page }) => {
  await openRoute(page, '/search');
  await page.locator('[data-search-input]').fill(WORDS);
  const hits = page.locator('[data-search-hit]');
  await expect(hits.first()).toBeVisible();

  await page.locator('[data-search-project]').selectOption({ label: 'ledger-sync' });
  await expect(hits).not.toHaveCount(0);
  await expect(hits.filter({ hasNotText: 'ledger-sync' })).toHaveCount(0);

  await page.locator('[data-search-filters]').getByRole('button', { name: 'Archived' }).click();
  await expect(page.getByText('Nothing found')).toBeVisible();
});

test('Settings shows the index, rebuilds it and clears it', async ({ page }) => {
  await openRoute(page, '/settings');
  const summary = page.locator('[data-search-index-summary]');
  await expect(summary).toContainText(/\d+ sessions?, \d+ messages?/);
  await expect(summary).not.toContainText('Empty');

  await page.locator('[data-search-clear]').click();
  await page.locator('[data-search-clear-confirm]').click();
  await expect(summary).toContainText('Empty');

  await page.locator('[data-search-rebuild]').click();
  await expect(summary).not.toContainText('Empty');
});

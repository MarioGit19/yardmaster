import type { Browser, Page } from '@playwright/test';
import { startDemoBoard } from './board.js';
import { expect, openRoute, signedInState, test } from './fixtures.js';

// Each test gets its own demo board, so deciding a request never races the shared one.
async function openBoard(browser: Browser): Promise<{ page: Page; stop(): Promise<void> }> {
  const board = await startDemoBoard();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
  });
  const stop = async () => {
    await context.close();
    await board.stop();
  };
  try {
    const page = await context.newPage();
    await openRoute(page, '/');
    return { page, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Waits for the demo's first permission request (8–14 s in) and opens the sheet on it. */
async function openFirstRequest(page: Page) {
  const waiting = page.locator('[data-hud="waiting"]');
  await expect(waiting.locator('[data-value]')).not.toHaveAttribute('data-value', '0', {
    timeout: 30_000,
  });
  await waiting.click();
  const sheet = page.getByRole('complementary', { name: /Needs you/ });
  const card = sheet.locator('article[data-approval]').first();
  await expect(card).toHaveAttribute('data-selected', 'true');
  const id = await card.getAttribute('data-approval');
  if (!id) throw new Error('the approval card has no id');
  return { sheet, card: sheet.locator(`article[data-approval="${id}"]`) };
}

test('a demo request is approved with the keyboard', async ({ browser }) => {
  test.slow();
  const { page, stop } = await openBoard(browser);
  try {
    // The new request was announced to screen readers.
    await expect(page.locator('[data-attention-live]')).toContainText('Approval needed', {
      timeout: 30_000,
    });
    const { sheet, card } = await openFirstRequest(page);
    // The exact payload: every demo request is a command or a file.
    await expect(card.locator('[data-command], code, .diff').first()).not.toBeEmpty();
    await expect(card.getByRole('button', { name: /^Allow/ })).toBeVisible();

    await page.keyboard.press('a');
    await expect(card).toHaveAttribute('data-resolved', 'allowed');
    await expect(card.locator('[data-outcome="allowed"]')).toHaveText('Allowed');
    // Then the card collapses out of the list.
    await expect(card).toHaveCount(0);
    await expect(sheet).toBeVisible();
  } finally {
    await stop();
  }
});

test('a demo request is denied with a reason', async ({ browser }) => {
  test.slow();
  const { page, stop } = await openBoard(browser);
  try {
    const { card } = await openFirstRequest(page);
    await page.keyboard.press('d');
    const reason = card.getByRole('textbox', { name: /Reason/ });
    await expect(reason).toBeFocused();
    // The D that opened the field isn't typed into it.
    await expect(reason).toHaveValue('');
    // Escape leaves the denial without closing the sheet.
    await page.keyboard.press('Escape');
    await expect(reason).toHaveCount(0);
    await expect(card).toBeVisible();

    await page.keyboard.press('d');
    await reason.fill('Run the migration on staging first');
    await reason.press('Enter');
    await expect(card).toHaveAttribute('data-resolved', 'denied');
    await expect(card).toHaveCount(0);
  } finally {
    await stop();
  }
});

test('a new request shows a toast that opens the Attention Center', async ({ browser }) => {
  test.slow();
  const { page, stop } = await openBoard(browser);
  try {
    const toast = page.locator('[data-sonner-toast]', { hasText: /wants to run/ });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await toast.getByRole('button', { name: 'Review' }).click();
    const sheet = page.getByRole('complementary', { name: /Needs you/ });
    await expect(sheet.locator('article[data-approval]').first()).toBeVisible();
  } finally {
    await stop();
  }
});

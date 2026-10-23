import type { Page } from '@playwright/test';
import { expect, firstProjectRoute, openRoute, test } from './fixtures.js';

/** A unique marker, so parallel tests on the shared demo board can't satisfy each other. */
const marker = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}`;

/** Starts a board session in the first project from its new-session composer; returns its id. */
async function startBoardSession(page: Page, narrow = false) {
  await openRoute(page, '/');
  await openRoute(page, await firstProjectRoute(page));
  if (narrow) await page.getByRole('tab', { name: 'Sessions' }).click();
  await page.locator('[data-new-session]').click();
  const input = page.getByRole('textbox', { name: 'First message for a new session' });
  await expect(input).toBeVisible();
  await input.fill(marker('first'));
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/p\/[^/]+\/s\/[^/]+$/);
  return decodeURIComponent(page.url().split('/s/')[1] ?? '');
}

const composerOf = (page: Page, sessionId: string) =>
  page.locator(`[data-session-panel="${sessionId}"]`).getByRole('textbox', { name: /^Message / });

test.describe('drafts', () => {
  test('a draft survives switching sessions and a reload, and shows on its row', async ({
    page,
  }) => {
    test.slow();
    const sessionId = await startBoardSession(page);
    const input = composerOf(page, sessionId);
    const draft = `Then ${marker('draft')}`;
    await input.fill(draft);

    // Another session takes the Claude column; the draft waits on its own row.
    const row = page.locator(`[data-focus] a[data-session="${sessionId}"]`);
    const other = page.locator(`[data-focus] a[data-session]:not([data-session="${sessionId}"])`);
    await other.first().click();
    await expect(input).toHaveCount(0);
    await expect(row.locator('[data-draft-marker]')).toHaveText('Draft');
    await row.click();
    await expect(input).toHaveValue(draft);
    // The caret is at the end of the restored text.
    expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(draft.length);

    await page.reload();
    await expect(input).toHaveValue(draft);
    await expect(row.locator('[data-draft-marker]')).toBeVisible();

    // Sending clears it, and the marker goes.
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(row.locator('[data-draft-marker]')).toHaveCount(0);
    await page.reload();
    await expect(input).toHaveValue('');
  });

  test("the new-session composer and the new-terminal command keep what's typed", async ({
    page,
  }) => {
    await openRoute(page, '/');
    await openRoute(page, await firstProjectRoute(page));
    await page.locator('[data-new-session]').click();
    const first = page.getByRole('textbox', { name: 'First message for a new session' });
    const prompt = marker('prompt');
    await first.fill(prompt);
    await page.locator('[data-focus] a[data-session]').first().click();
    await expect(first).toHaveCount(0);
    await page.locator('[data-new-session]').click();
    await expect(first).toHaveValue(prompt);

    const stack = page.locator('[data-terminal-stack]');
    await stack.getByRole('button', { name: 'New terminal' }).click();
    const popover = page.locator('[data-new-terminal-popover]');
    const command = popover.getByRole('textbox', { name: 'Command to run (optional)' });
    const line = `echo ${marker('cmd')}`;
    await command.fill(line);
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await stack.getByRole('button', { name: 'New terminal' }).click();
    await expect(command).toHaveValue(line);
    await expect(command).toBeFocused();
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('a draft survives switching tabs and a reload', async ({ page }) => {
      test.slow();
      const sessionId = await startBoardSession(page, true);
      const tabs = page.getByRole('tablist', { name: 'Focus view panels' });
      await tabs.getByRole('tab', { name: 'Claude' }).click();
      const input = composerOf(page, sessionId);
      const draft = marker('phone');
      await input.fill(draft);

      await tabs.getByRole('tab', { name: 'Terminals' }).click();
      await expect(input).toBeHidden();
      await tabs.getByRole('tab', { name: 'Sessions' }).click();
      await expect(
        page.locator(`[data-focus] a[data-session="${sessionId}"] [data-draft-marker]`),
      ).toBeVisible();
      await tabs.getByRole('tab', { name: 'Claude' }).click();
      await expect(input).toHaveValue(draft);

      await page.reload();
      await tabs.getByRole('tab', { name: 'Claude' }).click();
      await expect(input).toHaveValue(draft);
    });
  });
});

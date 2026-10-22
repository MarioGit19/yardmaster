import type { Page } from '@playwright/test';
import { expect, firstProjectRoute, openRoute, test } from './fixtures.js';

async function openFirstProject(page: Page) {
  await openRoute(page, '/');
  await openRoute(page, await firstProjectRoute(page));
}

// Board sessions in demo mode run the real runner over a scripted query (no Claude, no API).

test.describe('composer', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('starts a session, sends, streams and interrupts', async ({ page }) => {
    // Two scripted turns stream for several seconds each.
    test.slow();
    await openFirstProject(page);
    await page.locator('[data-new-session]').click();
    const panel = page.locator('[data-new-session-panel]');
    await expect(panel).toBeVisible();

    // Shift+Enter is a newline; Enter sends.
    const input = panel.getByRole('textbox', { name: 'First message for a new session' });
    await expect(input).toBeFocused();
    await input.pressSequentially('Plan the cart refactor');
    await input.press('Shift+Enter');
    await input.pressSequentially('Keep the public API.');
    await expect(input).toHaveValue('Plan the cart refactor\nKeep the public API.');
    await panel.getByRole('combobox', { name: 'Model' }).selectOption('sonnet');
    await input.press('Enter');

    // The route moves to the new board session.
    await expect(page).toHaveURL(/#\/p\/[^/]+\/s\/[^/]+$/);
    const sessionId = decodeURIComponent(page.url().split('/s/')[1] ?? '');
    const session = page.locator(`[data-session-panel="${sessionId}"]`);
    await expect(session).toBeVisible();
    await expect(session.locator('header [data-origin="board"]')).toBeVisible();
    await expect(page.locator(`[data-session="${sessionId}"] [data-origin="board"]`)).toBeVisible();
    const list = session.locator('[data-message-list]');
    await expect(list.locator('[data-row="user"]').first()).toContainText('Plan the cart refactor');
    await expect(session.getByRole('combobox', { name: 'Model' })).toHaveValue('sonnet');

    // First turn: a tool call, then the reply streams in and lands.
    await expect(list.locator('[data-row="tool"]')).toHaveCount(1);
    await expect(list.locator('[data-row="tail"]')).toBeVisible();
    await expect(list.locator('[data-row="tail"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(list.locator('[data-row="assistant"]')).toHaveCount(1);
    const send = session.locator('form[data-composer] button[type="submit"]');
    await expect(send).toHaveAttribute('data-mode', 'send');

    // Second turn: Stop shows while it streams; Esc interrupts and keeps what was written.
    const reply = session.getByRole('textbox', { name: /^Message / });
    await reply.fill('Why that approach?');
    await reply.press('Enter');
    await expect(reply).toHaveValue('');
    await expect(list.locator('[data-row="user"]')).toHaveCount(2);
    await expect(list.locator('[data-row="tail"]')).toBeVisible();
    await expect(send).toHaveAttribute('data-mode', 'stop');
    await reply.press('Escape');
    await expect(send).toHaveAttribute('data-mode', 'send');
    await expect(list.locator('[data-row="tail"]')).toHaveCount(0);
    await expect(list.locator('[data-row="assistant"]')).toHaveCount(2);
    // Escape stopped Claude; it didn't close the focus view.
    await expect(session).toBeVisible();
    await expect(session.locator('header')).toContainText('Idle');
  });

  test('a terminal session offers Resume here (fork)', async ({ page }) => {
    await openFirstProject(page);
    const terminalSession = page
      .locator('[data-focus] a[data-session]')
      .filter({ hasNot: page.locator('[data-origin="board"]') })
      .first();
    await terminalSession.click();
    const bar = page.locator('[data-fork-bar]');
    await expect(bar).toBeVisible();
    await expect(page.locator('form[data-composer]')).toHaveCount(0);
    const parentId = await terminalSession.getAttribute('data-session');

    await bar.getByRole('button', { name: 'Resume here (fork)' }).click();
    await expect(page).toHaveURL(/#\/p\/[^/]+\/s\/[^/]+$/);
    await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}$`));
    const fork = page.locator('[data-session-panel]');
    await expect(fork.locator('header [data-origin="board"]')).toBeVisible();
    await expect(fork.locator('form[data-composer]')).toBeVisible();
  });
  test('Reply in terminal is offered only while its setting is on', async ({ page }) => {
    // Four route changes through Settings.
    test.slow();
    const setReply = async (value: 'On' | 'Off') => {
      await openRoute(page, '/settings');
      const row = page.locator('[data-setting="terminal-reply"]');
      await expect(row.getByRole('button', { name: 'Off' })).toBeEnabled();
      await row.getByRole('button', { name: value }).click();
      await expect(row.getByRole('button', { name: value })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    };

    try {
      await setReply('Off');
      await openFirstProject(page);
      const terminalSession = page
        .locator('[data-focus] a[data-session]')
        .filter({ hasNot: page.locator('[data-origin="board"]') })
        .first();
      const route = (await terminalSession.getAttribute('href'))?.slice(1);
      if (!route) throw new Error('no terminal session');
      await terminalSession.click();
      await expect(page.locator('[data-fork-bar]')).toBeVisible();
      await expect(page.locator('[data-terminal-reply]')).toHaveCount(0);

      await setReply('On');
      await openRoute(page, route);
      const reply = page.locator('[data-terminal-reply]');
      await expect(reply).toBeVisible();
      // Sending waits on the demo's turn timing, so the routing is covered by the server tests.
      await expect(reply.getByRole('textbox', { name: 'Reply in the terminal' })).toBeVisible();
      await expect(reply.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();

      await setReply('Off');
      await openRoute(page, route);
      await expect(page.locator('[data-fork-bar]')).toBeVisible();
      await expect(page.locator('[data-terminal-reply]')).toHaveCount(0);
    } finally {
      await setReply('Off');
    }
  });
});

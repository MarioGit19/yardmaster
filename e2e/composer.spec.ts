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

  test("a terminal session's composer types into its terminal; the fork is in its menu", async ({
    page,
  }) => {
    test.setTimeout(200_000);
    await openFirstProject(page);
    const tab = page.locator('[data-terminal-stack] [data-claude-tab]').first();
    await expect(tab).toBeVisible({ timeout: 30_000 });
    const parentId = await tab.getAttribute('data-claude-tab');
    await page.locator(`[data-focus] a[data-session="${parentId}"]`).click();
    const panel = page.locator(`[data-session-panel="${parentId}"]`);
    // The TUI owns model and mode; no fork bar while the board can type into the terminal.
    await expect(panel.locator('[data-fork-bar]')).toHaveCount(0);
    await expect(panel.getByRole('combobox', { name: 'Model' })).toHaveCount(0);

    // While Claude asks for permission the approval takes the composer's place; the composer
    // comes back once it is answered or expires (not answered here: the attention tests use it).
    const more = panel.getByRole('button', { name: 'More actions' });
    await expect(more).toBeVisible({ timeout: 150_000 });
    await more.click();
    const menu = page.locator('[data-composer-menu]');
    await expect(menu).toContainText('Running in a terminal; reply there from the chat');
    const parentName = await panel.locator('header h2').textContent();
    await menu.getByRole('button', { name: /Fork into the board/ }).click();
    await expect(page).toHaveURL(/#\/p\/[^/]+\/s\/[^/]+$/);
    await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}$`));
    const fork = page.locator('[data-session-panel]');
    await expect(fork.locator('header [data-origin="board"]')).toBeVisible();
    await expect(fork.locator('form[data-composer]')).toBeVisible();
    // Its own "Claude N", a link back to the parent, and the parent's messages above a divider.
    const name = fork.locator('header h2');
    await expect(name).toHaveText(/^Claude( \d+)?$/);
    await expect(name).not.toHaveText(parentName ?? '');
    await expect(fork.locator(`header [data-forked-from="${parentId}"]`)).toHaveText(
      `Forked from ${parentName}`,
    );
    await expect(fork.locator('[data-fork-divider]')).toHaveCount(1);
    await expect(fork.locator('[data-inherited]').first()).toBeAttached();
  });

  test('with replies turned off in Settings, a terminal session offers the fork bar', async ({
    page,
  }) => {
    // The setting lives on the shared demo server: keep it in this page, so parallel tests
    // still see it on.
    let terminalReply = true;
    await page.route('**/api/settings', async (route) => {
      const response = await route.fetch({ method: 'GET' });
      const current = await response.json();
      if (route.request().method() === 'PUT') {
        const patch = route.request().postDataJSON() as { terminalReply?: boolean };
        if (patch.terminalReply !== undefined) terminalReply = patch.terminalReply;
      }
      await route.fulfill({ response, json: { ...current, terminalReply } });
    });

    await openRoute(page, '/settings');
    const row = page.locator('[data-setting="terminal-reply"]');
    await expect(row).toContainText('Reply to terminal sessions from the board');
    // On by default.
    await expect(row.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
    await row.getByRole('button', { name: 'Off' }).click();
    await expect(row.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');

    await openFirstProject(page);
    const tab = page.locator('[data-terminal-stack] [data-claude-tab]').first();
    await expect(tab).toBeVisible({ timeout: 30_000 });
    const sessionId = await tab.getAttribute('data-claude-tab');
    await page.locator(`[data-focus] a[data-session="${sessionId}"]`).click();
    const panel = page.locator(`[data-session-panel="${sessionId}"]`);
    await expect(panel.locator('[data-fork-bar]')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Fork into the board' })).toBeVisible();
    await expect(panel.locator('form[data-composer]')).toHaveCount(0);
  });
});

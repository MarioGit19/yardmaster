import type { Locator, Page } from '@playwright/test';
import { expect, firstProjectRoute, openRoute, test } from './fixtures.js';

/** A unique marker, so parallel tests on the shared demo board can't satisfy each other. */
const marker = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}`;

/** The first demo project (acme-shop: dev server, tests, zsh and a terminal running claude). */
async function openProject(page: Page, narrow = false) {
  await openRoute(page, '/');
  await openRoute(page, await firstProjectRoute(page));
  if (narrow) await page.getByRole('tab', { name: 'Terminals' }).click();
  const stack = page.locator('[data-terminal-stack]');
  await expect(stack).toBeVisible();
  return stack;
}

/** The project's Claude terminal tab and its session. The demo relaunches an ended session. */
async function claudeTab(stack: Locator) {
  const tab = stack.locator('[data-claude-tab]').first();
  await expect(tab).toBeVisible({ timeout: 30_000 });
  const sessionId = await tab.getAttribute('data-claude-tab');
  if (!sessionId) throw new Error('no linked session');
  return { tab, sessionId };
}

test.describe('Claude terminals', () => {
  // The WebGL renderer draws text into a canvas; the DOM fallback keeps it readable here.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
        return String(args[0]).startsWith('webgl')
          ? null
          : (getContext.apply(this, args as Parameters<typeof getContext>) as never);
      } as typeof getContext;
    });
  });

  test.describe('desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('the tab and the session row select the same session; raw on demand', async ({ page }) => {
      const stack = await openProject(page);
      const { tab, sessionId } = await claudeTab(stack);
      await expect(tab).toHaveAccessibleName(/^claude, Claude, /);

      await tab.click();
      await expect(page).toHaveURL(new RegExp(`/s/${sessionId}$`));
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(`[data-session-panel="${sessionId}"]`)).toBeVisible();
      await expect(page.locator(`a[data-session="${sessionId}"]`)).toHaveAttribute(
        'aria-current',
        'page',
      );
      // The Claude column shows the chat already: the pane points to it.
      await expect(stack.locator(`[data-chat-beside="${sessionId}"]`)).toBeVisible();

      await stack.getByRole('button', { name: 'Raw terminal' }).click();
      const pane = stack.locator('[data-pane]');
      await expect(pane).toHaveAttribute('data-pane-content', 'xterm');
      await expect(stack.locator('[data-xterm]')).toBeVisible();

      // Another tab and back: the raw choice holds for the page's lifetime.
      await stack.getByRole('tab', { name: /^zsh\b/ }).click();
      await expect(stack.locator('[data-claude-pane]')).toHaveCount(0);
      // The session row picks the Claude tab again.
      await page.locator(`a[data-session="${sessionId}"]`).click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(stack.getByRole('button', { name: 'Raw terminal' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await stack.getByRole('button', { name: 'Chat' }).click();
      await expect(stack.locator(`[data-chat-beside="${sessionId}"]`)).toBeVisible();
    });

    test('a new terminal opens from a recent-command chip and becomes the active tab', async ({
      page,
    }) => {
      const stack = await openProject(page);
      await expect(stack.locator('[data-tab]').first()).toBeVisible();
      const before = await stack
        .locator('[data-tab]')
        .evaluateAll((tabs) => tabs.map((t) => t.getAttribute('data-tab')));
      await stack.getByRole('button', { name: 'New terminal' }).click();
      const popover = page.locator('[data-new-terminal-popover]');
      await expect(popover).toBeVisible();
      await expect(
        popover.getByRole('textbox', { name: 'Command to run (optional)' }),
      ).toBeFocused();
      await expect(popover.locator('[data-command-chip="claude"]')).toBeVisible();
      const chip = popover.locator('[data-command-chip]:not([data-command-chip="claude"])').first();
      const command = (await chip.getAttribute('data-command-chip')) ?? '';
      expect(command).not.toBe('');
      await chip.click();
      await expect(popover).toBeHidden();

      const tabIds = () =>
        stack.locator('[data-tab]').evaluateAll((tabs) => tabs.map((t) => t.dataset.tab ?? ''));
      await expect
        .poll(async () => (await tabIds()).filter((id) => !before.includes(id)), {
          timeout: 10_000,
        })
        .toHaveLength(1);
      const [created] = (await tabIds()).filter((id) => !before.includes(id));
      const fresh = stack.locator(`[data-tab="${created}"]`);
      await expect(fresh).toHaveAttribute('aria-selected', 'true');
      await expect(fresh).toHaveAccessibleName(new RegExp(`^acme-shop: ${command}`));
    });

    test('⌘K opens the new-terminal popover in the project', async ({ page }) => {
      await openRoute(page, '/');
      await page.keyboard.press('ControlOrMeta+K');
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await palette.getByRole('combobox').fill('new terminal acme');
      const command = palette.locator('[data-command^="new-terminal:"]', {
        hasText: 'New terminal in acme-shop',
      });
      await expect(command).toHaveAttribute('data-selected', 'true');
      await palette.getByRole('combobox').press('Enter');
      await expect(page).toHaveURL(/#\/p\/[^/]+$/);
      await expect(page.locator('[data-new-terminal-popover]')).toBeVisible();
      await expect(page.locator('[data-new-terminal-popover]')).toContainText(
        'New terminal in acme-shop',
      );
    });
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('the tab shows the chat; long and multi-line replies from its composer are submitted in the terminal', async ({
      page,
    }) => {
      // The reply waits for the demo session to finish its turn, or a permission request to expire
      // (approving it here would take it from the attention tests running alongside), twice.
      test.setTimeout(480_000);
      const stack = await openProject(page, true);
      const { tab, sessionId } = await claudeTab(stack);
      await tab.click();
      const chat = stack.locator(`[data-pane] [data-session-panel="${sessionId}"]`);
      await expect(chat).toBeVisible();

      await stack.getByRole('button', { name: 'Raw terminal' }).click();
      await expect(stack.locator('[data-xterm]')).toBeVisible();
      await expect(chat).toHaveCount(0);
      await stack.getByRole('button', { name: 'Chat' }).click();
      await expect(chat).toBeVisible();

      const input = chat.getByRole('textbox', { name: /^Message / });
      const atPrompt = () =>
        expect
          .poll(
            async () => ((await input.isVisible()) ? input.getAttribute('placeholder') : null),
            { timeout: 200_000, intervals: [500] },
          )
          .toBe('Reply to Claude…');
      await atPrompt();

      // The finished turn's answer: where it sits, and its first line.
      const answer = chat.locator('[data-row="assistant"]').last();
      const index = Number(await answer.getAttribute('data-index'));
      const previous = ((await answer.innerText()).split('\n')[0] ?? '').trim();
      expect(previous).not.toBe('');

      // 500 characters: Claude's TUI reads it as a paste, and it must still be submitted. The chat
      // clamps it, and the terminal has scrolled past its start: a marker at each end.
      const reply = marker('reply');
      const end = marker('end');
      const filler = 'Check the totals with discounts and tax. '.repeat(13);
      const long = `Also cover ${reply}. ${filler}`.slice(0, 500 - end.length - 1).trimEnd();
      const longReply = `${long} ${end}`;
      expect(longReply.length).toBeGreaterThan(490);
      await input.fill(longReply);
      await chat.getByRole('button', { name: 'Send' }).click();
      await expect(input).toHaveValue('');
      const sent = chat.locator('[data-row="user"]', { hasText: reply });
      await expect(sent).toBeVisible();

      // The previous answer stays once, above the new message, never as the new turn's tail.
      await expect(chat.locator(`[data-index="${index}"]`)).toContainText(previous);
      expect(Number(await sent.getAttribute('data-index'))).toBeGreaterThan(index);
      const laterCopies = () =>
        chat
          .locator('[data-row]')
          .evaluateAll(
            (rows, [from, text]) =>
              rows.filter((r) => Number(r.dataset.index) > from && r.textContent?.includes(text))
                .length,
            [index, previous] as const,
          );
      expect(await laterCopies()).toBe(0);
      // While Claude works on the new turn the transcript ends on its live caption or new text.
      await expect(
        chat.locator('[data-row="caption"], [data-row="tail"], [data-row="tool"]').last(),
      ).toBeVisible();
      expect(await laterCopies()).toBe(0);

      await stack.getByRole('button', { name: 'Raw terminal' }).click();
      await expect(stack.locator('[data-xterm] .xterm-rows')).toContainText(end);

      // A multi-line reply keeps its lines.
      await stack.getByRole('button', { name: 'Chat' }).click();
      await atPrompt();
      const first = marker('first');
      const second = marker('second');
      await input.fill(`Then ${first}\nand ${second}`);
      await chat.getByRole('button', { name: 'Send' }).click();
      await expect(input).toHaveValue('');
      const lines = chat.locator('[data-row="user"]', { hasText: first });
      await expect(lines).toBeVisible();
      await expect(lines).toContainText(second);
      await stack.getByRole('button', { name: 'Raw terminal' }).click();
      const rows = stack.locator('[data-xterm] .xterm-rows');
      await expect(rows).toContainText(`Then ${first}`);
      await expect(rows).toContainText(`and ${second}`);
    });
  });
});

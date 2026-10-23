import type { Page } from '@playwright/test';
import { expect, firstProjectRoute, openRoute, test } from './fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

/** Opens the first demo project (acme-shop: dev server, tests, zsh, claude) in the focus view. */
async function openStack(page: Page) {
  await openRoute(page, '/');
  await openRoute(page, await firstProjectRoute(page));
  const stack = page.locator('[data-terminal-stack]');
  await expect(stack).toBeVisible();
  return stack;
}

/** A unique marker, so parallel tests on the shared demo board can't satisfy each other. */
const marker = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}`;

test.describe('terminal stack', () => {
  // One shared demo zsh: commands from parallel tests would race each other's exit badges.
  test.describe.configure({ mode: 'serial' });
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

  test('typing into a demo terminal echoes, and a failing command shows the exit badge', async ({
    page,
  }) => {
    const stack = await openStack(page);
    const tab = stack.locator('[role="tab"][data-terminal-name="zsh"]');
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');

    const xterm = stack.locator('[data-xterm]');
    await expect(xterm).toHaveAttribute('data-renderer', 'dom');
    const input = stack.getByRole('textbox', { name: 'Send to acme-shop · zsh' });
    const hello = marker('hello');
    await input.fill(`echo ${hello}`);
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(xterm.locator('.xterm-rows')).toContainText(hello);

    await input.fill('exit 3');
    await input.press('Enter');
    await expect(tab.locator('[data-exit="3"]')).toBeVisible();
    await expect(tab).toHaveAccessibleName(/failed with exit code 3/);

    // ↑ brings the last command back.
    await input.press('ArrowUp');
    await expect(input).toHaveValue('exit 3');
  });

  test('hidden tabs dispose their renderer and replay their output when shown again', async ({
    page,
  }) => {
    const stack = await openStack(page);
    const zsh = stack.locator('[role="tab"][data-terminal-name="zsh"]');
    await zsh.click();
    const input = stack.getByRole('textbox', { name: 'Send to acme-shop · zsh' });
    const kept = marker('kept');
    await input.fill(`echo ${kept}`);
    await input.press('Enter');
    await expect(stack.locator('[data-xterm] .xterm-rows')).toContainText(kept);

    await stack.getByRole('tab', { name: /^tests\b/ }).click();
    await expect(stack.locator('[data-xterm]')).toHaveCount(1);
    await expect(stack.locator(`[data-xterm] .xterm-rows`)).not.toContainText(kept);

    await zsh.click();
    await expect(stack.locator('[data-xterm] .xterm-rows')).toContainText(kept);
  });

  test('a running interactive app shows the open-in-editor card', async ({ page }) => {
    const stack = await openStack(page);
    await stack.locator('[role="tab"][data-terminal-name="zsh"]').click();
    const input = stack.getByRole('textbox', { name: 'Send to acme-shop · zsh' });
    await input.fill('htop');
    await input.press('Enter');
    const card = stack.locator('[data-interactive]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('Interactive app, open in');
    await expect(stack.locator('[data-xterm]')).toHaveCount(0);
    // Ctrl+C ends it, and the mirror comes back.
    await stack.getByRole('button', { name: 'Send Ctrl+C' }).click();
    await expect(card).toHaveCount(0);
    await expect(stack.locator('[data-xterm]')).toHaveCount(1);
  });

  test('without a choice the stack opens on a terminal it can mirror', async ({ page }) => {
    const stack = await openStack(page);
    // Wait until the claude terminal's interactive run is known, then check the pick held.
    await stack.locator('[role="tab"][data-terminal-name="claude"]').waitFor();
    await expect(stack.locator('[data-xterm]')).toHaveCount(1, { timeout: 10_000 });
    await expect(stack.locator('[data-interactive]')).toHaveCount(0);
    await expect(stack.locator('[role="tab"][data-terminal-name="claude"]')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  test('the grid shows four terminals, and maximize covers the view until Escape', async ({
    page,
  }) => {
    const stack = await openStack(page);
    await stack.getByRole('button', { name: 'Show up to four terminals' }).click();
    await expect(stack.locator('[data-pane]')).toHaveCount(4);
    await stack.getByRole('button', { name: 'Show one terminal' }).click();
    await expect(stack.locator('[data-pane]')).toHaveCount(1);

    await stack.getByRole('button', { name: 'Maximize terminals' }).click();
    await expect(page.locator('.focus-col-max')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.focus-col-max')).toHaveCount(0);
    // The focus view is still open: the first Escape only restored the stack.
    await expect(stack).toBeVisible();
  });

  test('search highlights matches in the output', async ({ page }) => {
    const stack = await openStack(page);
    await stack.locator('[role="tab"][data-terminal-name="zsh"]').click();
    const input = stack.getByRole('textbox', { name: 'Send to acme-shop · zsh' });
    const needle = marker('needle');
    await input.fill(`echo ${needle}`);
    await input.press('Enter');
    await expect(stack.locator('[data-xterm] .xterm-rows')).toContainText(needle);

    await stack.getByRole('button', { name: 'Search output' }).click();
    const search = stack.getByRole('searchbox', { name: 'Search terminal output' });
    await search.fill(needle);
    await expect(stack.getByText(/^1\/\d+$/)).toBeVisible();
    await search.press('Escape');
    await expect(search).toHaveCount(0);
  });
});

test('the terminal uses the WebGL renderer where the browser has it', async ({ page }) => {
  const stack = await openStack(page);
  await stack.locator('[role="tab"][data-terminal-name="zsh"]').click();
  await expect(stack.locator('[data-xterm]')).toHaveAttribute('data-renderer', /^(webgl|dom)$/);
  const webgl = await page.evaluate(() =>
    Boolean(document.createElement('canvas').getContext('webgl2')),
  );
  if (webgl) await expect(stack.locator('[data-xterm]')).toHaveAttribute('data-renderer', 'webgl');
});

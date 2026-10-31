import type { Page } from '@playwright/test';
import { expect, openRoute, sessionHeader, test } from './fixtures.js';

/** The demo renames orbit-api's `zsh` to `backend` this long after it starts (demo/content.ts). */
const DEMO_RENAME_MS = 20_000;
/** How soon a rename must show once the server has it. */
const RENAME_SHOWS_MS = 3_000;
const RENAMED = 'demo-term-orbit-api-2';

test.use({ viewport: { width: 1440, height: 900 } });

/** Opens a project from the overview and returns its terminal stack. */
async function openProject(page: Page, name: string) {
  await openRoute(page, '/');
  const link = page.locator('a[href^="#/p/"]', { hasText: name }).first();
  const href = await link.getAttribute('href');
  const id = href?.match(/^#\/p\/([^/]+)/)?.[1];
  if (!id) throw new Error(`no route for ${name}`);
  await link.click();
  // By id: the project before it can still be fading out behind the new one.
  const stack = page.locator(`[data-terminal-stack="${decodeURIComponent(id)}"]`);
  await expect(stack).toBeVisible();
  return stack;
}

test('a terminal renamed in the editor shows its new name in its tab and lane', async ({
  page,
}) => {
  test.setTimeout(DEMO_RENAME_MS + 30_000);
  const stack = await openProject(page, 'orbit-api');
  const tab = stack.locator(`[data-tab="${RENAMED}"]`);
  await expect(tab).toBeAttached();

  const status = await page.request.get('/api/status', { headers: sessionHeader() });
  const { uptimeMs } = (await status.json()) as { uptimeMs: number };
  const untilRename = DEMO_RENAME_MS - uptimeMs;
  if (untilRename > 1_000) {
    // Still the editor's automatic name: shown as a command or the folder, never as `zsh`.
    await expect(tab).toHaveAttribute('data-terminal-name', 'zsh');
    await expect(tab).not.toHaveAccessibleName(/^zsh\b/);
  }
  await expect(tab).toHaveAccessibleName(/^backend\b/, {
    timeout: Math.max(0, untilRename) + RENAME_SHOWS_MS,
  });

  await openRoute(page, '/');
  await expect(page.locator(`[data-lane="${RENAMED}"] [data-lane-name]`)).toHaveText('backend', {
    timeout: RENAME_SHOWS_MS,
  });
});

test('unnamed sessions are Claude and Claude 2, a renamed one keeps its name', async ({ page }) => {
  await openProject(page, 'pixel-studio');
  const names = page.locator('[data-focus] a[data-session] [data-session-name]');
  await expect(names.filter({ hasText: /^Claude( \d+)?$/ })).toHaveCount(2, { timeout: 15_000 });
  await expect(names.filter({ hasText: /^Claude$/ })).toHaveCount(1);
  // Claude Code's automatic name or the summary stays out of the title.
  await expect(page.locator('[data-session-panel] h2')).toHaveText(/^Claude( \d+)?$/);

  const stack = await openProject(page, 'ledger-sync');
  await expect(names.filter({ hasText: 'retry-backoff' })).toHaveCount(1, { timeout: 15_000 });
  await expect(stack.locator('[data-claude-tab]').first()).toContainText('retry-backoff');
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startBoard } from './board.js';
import { expect, signedInState, test } from './fixtures.js';
import { connectEditor, OBSERVER_HOOK, runHook } from './local.js';

// Synthetic hook payload and editor window (privacy: no real paths or ids).
const SESSION_ID = '0b5e7c2a-4d1f-4e8a-9c3b-7a6f5e4d3c2b';
const HOOK_EVENT = {
  session_id: SESSION_ID,
  transcript_path: `/home/dev/.claude/projects/-home-dev-acme-shop/${SESSION_ID}.jsonl`,
  cwd: '/home/dev/acme-shop',
  permission_mode: 'default',
  hook_event_name: 'SessionStart',
  source: 'startup',
};

test('the onboarding steps tick themselves from simulated events', async ({ browser }) => {
  test.slow();
  const board = await startBoard({ demo: false });
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.session),
  });
  let editor: Awaited<ReturnType<typeof connectEditor>> | undefined;
  try {
    const token = (await readFile(join(board.home, 'token'), 'utf8')).trim();
    const page = await context.newPage();
    await page.goto('/#/');

    const wizard = page.locator('[data-onboarding]');
    await expect(wizard).toBeVisible();
    const step = (id: string) => wizard.locator(`[data-step="${id}"]`);
    await expect(step('server')).toHaveAttribute('data-done', 'true');
    await expect(step('hooks')).toHaveAttribute('data-done', 'false');
    await expect(step('extension')).toHaveAttribute('data-done', 'false');
    await expect(wizard.locator('[data-progress]')).toHaveText('1 of 3 done');
    await expect(step('extension').getByText('cursor --install-extension')).toBeVisible();

    // Install the hooks through the confirm dialog: it shows the exact diff before writing.
    await step('hooks').getByRole('button', { name: 'Install hooks' }).click();
    const dialog = page.locator('[data-hooks-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-hooks-diff]')).toContainText('yardmaster-hook');
    await dialog.locator('[data-hooks-confirm]').click();
    await expect(dialog).toBeHidden();
    await expect(step('hooks')).toContainText('Installed.');
    const settings = JSON.parse(await readFile(join(board.claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);

    // The first hook event (the real hook script, over the board's socket) ticks the hooks step.
    expect(await runHook(board, OBSERVER_HOOK, HOOK_EVENT)).toEqual({ code: 0, stdout: '' });
    await expect(step('hooks')).toHaveAttribute('data-done', 'true');
    await expect(wizard.locator('[data-progress]')).toHaveText('2 of 3 done');
    // The guide stays up although the event created the first project.
    await expect(wizard).toBeVisible();

    // An editor connection ticks the last one.
    editor = await connectEditor(board, token, ['/home/dev/acme-shop']);
    await expect(step('extension')).toHaveAttribute('data-done', 'true');
    await expect(wizard).toHaveAttribute('data-complete', 'true');
    await expect(wizard.getByRole('heading', { level: 1 })).toHaveText('You’re all set');

    await wizard.locator('[data-onboarding-done]').click();
    await expect(wizard).toBeHidden();
    await expect(page.locator('a[href^="#/p/"]').first()).toBeVisible();

    // Finished once: a reload goes straight to the board.
    await page.reload();
    await expect(page.locator('a[href^="#/p/"]').first()).toBeVisible();
    await expect(page.locator('[data-onboarding]')).toHaveCount(0);
  } finally {
    editor?.close();
    await context.close();
    await board.stop();
  }
});

test('settings show the hooks, editors and retention of the demo board', async ({ page }) => {
  await page.goto('/#/settings');
  const hooks = page.locator('[data-setting="hooks"]');
  await expect(hooks).toContainText('~/.claude/settings.json');
  await expect(hooks.getByRole('button', { name: /Install hooks|Reinstall/ })).toBeEnabled();
  await expect(page.locator('[data-setting="editors"] [data-window]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Demo mode never rotates the real token.
  await expect(page.getByRole('button', { name: 'Rotate token' })).toBeDisabled();
});

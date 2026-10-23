import type { Page } from '@playwright/test';
import { type DemoBoard, startDemoBoard } from './board.js';
import { expect, signedInState, test } from './fixtures.js';

// Opening a project adds it to the board, so these tests run on their own demo board and leave the
// shared one as it is. The demo library is synthetic (apps/server/src/demo/library.ts).

const MAC = process.platform === 'darwin';

let board: DemoBoard;

/** The project id from the focus view's route, once the launch has landed there. */
async function landedProject(page: Page, session: boolean): Promise<string> {
  const route = session ? /#\/p\/([^/]+)\/s\/[^/]+$/ : /#\/p\/([^/]+)$/;
  await expect(page).toHaveURL(route);
  const id = route.exec(page.url())?.[1];
  if (!id) throw new Error(`not in a focus view: ${page.url()}`);
  return decodeURIComponent(id);
}

test.beforeAll(async () => {
  board = await startDemoBoard();
});

test.afterAll(async () => {
  await board?.stop();
});

test.use({ viewport: { width: 1440, height: 900 } });

test('opens a library folder with Cursor, a terminal and a Claude session', async ({ browser }) => {
  test.slow();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto('/#/');
    await expect(page.locator('a[href^="#/p/"]').first()).toBeVisible();

    await page.locator('[data-hud="open-project"]').click();
    const dialog = page.locator('[data-open-project]');
    await expect(dialog).toBeVisible();
    // Recents first: the board's projects lead, the folders that aren't open follow.
    await expect(dialog.locator('[data-library-entry="garden-planner"]')).toBeVisible();
    await expect(dialog.locator('[data-library-entry]').first()).toHaveAttribute(
      'data-library-entry',
      /^(?!garden-planner|recipe-box|tax-notes|weather-bot)/,
    );
    await expect(dialog.locator('[data-library-entry="tax-notes"] [data-git]')).toHaveCount(0);

    await dialog.getByRole('combobox').fill('grdn');
    await expect(dialog.locator('[data-library-entry]')).toHaveCount(1);
    await dialog.getByRole('combobox').press('Enter');

    const sheet = dialog.locator('[data-launch-sheet="garden-planner"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-launch-option="editor"]')).toHaveAttribute('data-checked');
    await sheet.locator('[data-launch-option="claude"] label').click();
    await expect(sheet.locator('[data-launch-summary]')).toHaveText('Tell Claude what to do');
    await expect(sheet.getByRole('button', { name: 'Open project' })).toBeDisabled();
    await sheet.getByRole('textbox', { name: 'What should Claude do?' }).fill('Sketch the beds');
    await sheet.locator('[data-launch-option="terminal"] label').click();
    await sheet.getByRole('textbox', { name: 'Command to run (optional)' }).fill('pnpm dev');
    await expect(sheet.locator('[data-launch-summary]')).toHaveText('Cursor + pnpm dev + Claude');
    await sheet.getByRole('button', { name: 'Open project' }).click();

    // It lands in the focus view on the new session, with the terminal in the stack.
    await expect(dialog).toHaveCount(0);
    const projectId = await landedProject(page, true);
    const focus = page.locator(`[data-focus="${projectId}"]`);
    await expect(focus).toBeVisible();
    await expect(focus.locator('[data-session-panel]')).toBeVisible();
    await expect(focus.locator('[data-message-list] [data-row="user"]').first()).toContainText(
      'Sketch the beds',
    );
    await expect(focus.locator('[role="tab"][data-terminal-name="garden-planner"]')).toBeVisible({
      timeout: 10_000,
    });
    // The rail lists it, and its Cursor window connected.
    await expect(page.locator(`nav a[href="#/p/${projectId}"]`)).toBeVisible();

    // ⌘K → "Open project…": the folder is a recent now (it has a last-active time), with its
    // branch, and the sheet remembers the last choice.
    await page.keyboard.press(MAC ? 'Meta+K' : 'Control+K');
    await page.locator('[data-palette] [cmdk-input]').fill('open project');
    await page.locator('[data-command="open-project"]').click();
    await expect(dialog).toBeVisible();
    const recent = dialog.locator('[data-library-entry="garden-planner"]');
    await expect(recent.locator('time')).toBeVisible();
    await expect(recent.locator('[data-git]')).toHaveText('main');
    await recent.click();
    await expect(sheet.locator('[data-launch-option="claude"]')).toHaveAttribute('data-checked');
    await expect(sheet.locator('[data-launch-option="terminal"]')).toHaveAttribute('data-checked');
    await expect(sheet.getByRole('textbox', { name: 'Command to run (optional)' })).toHaveValue(
      'pnpm dev',
    );
    await expect(sheet.locator('[data-command-chip="pnpm dev"]')).toBeVisible();
    // Esc steps back to the list, a second Esc closes.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(dialog.locator('[data-library-entry]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // ⌘O opens it too, from anywhere.
    await page.keyboard.press(MAC ? 'Meta+O' : 'Control+O');
    await expect(dialog).toBeVisible();
  } finally {
    await context.close();
  }
});

test('starts only a terminal from the rail button', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto('/#/');
    await page.locator('[data-rail-open-project]').click();
    const dialog = page.locator('[data-open-project]');
    await dialog.locator('[data-library-entry="recipe-box"]').click();
    const sheet = dialog.locator('[data-launch-sheet="recipe-box"]');
    await sheet.locator('[data-launch-option="editor"] label').click();
    await sheet.locator('[data-launch-option="terminal"] label').click();
    await expect(sheet.locator('[data-launch-summary]')).toHaveText('terminal');
    await sheet.getByRole('button', { name: 'Open project' }).click();

    const projectId = await landedProject(page, false);
    const focus = page.locator(`[data-focus="${projectId}"]`);
    await expect(focus.locator('[role="tab"][data-terminal-name="recipe-box"]')).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await context.close();
  }
});

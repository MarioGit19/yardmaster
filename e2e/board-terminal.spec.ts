import { type DemoBoard, startDemoBoard } from './board.js';
import { expect, signedInState, test } from './fixtures.js';

// Board terminals (F19) on their own demo board: opening a folder adds it to the board. The demo's
// board terminals run a synthetic shell (apps/server/src/demo/pty.ts), never a real one.

let board: DemoBoard;

test.beforeAll(async () => {
  board = await startDemoBoard();
});

test.afterAll(async () => {
  await board?.stop();
});

test.use({ viewport: { width: 1440, height: 900 } });

test('types straight into a board terminal, which survives a reload', async ({ browser }) => {
  test.slow();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
    viewport: { width: 1440, height: 900 },
  });
  // The WebGL renderer draws text into a canvas; the DOM fallback keeps it readable here.
  await context.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      return String(args[0]).startsWith('webgl')
        ? null
        : (getContext.apply(this, args as Parameters<typeof getContext>) as never);
    } as typeof getContext;
  });
  try {
    const page = await context.newPage();
    await page.goto('/#/');
    await page.locator('[data-rail-open-project]').click();
    const dialog = page.locator('[data-open-project]');
    await dialog.locator('[data-library-entry="weather-bot"]').click();
    const sheet = dialog.locator('[data-launch-sheet="weather-bot"]');
    // Not in Cursor: with no editor window, the terminal runs on the board.
    await sheet.locator('[data-launch-option="editor"] label').click();
    await sheet.locator('[data-launch-option="terminal"] label').click();
    await expect(sheet.locator('[data-launch-option="terminal"]')).toContainText(
      'Runs on the board',
    );
    await sheet.getByRole('button', { name: 'Open project' }).click();
    await expect(dialog).toHaveCount(0);

    const stack = page.locator('[data-terminal-stack]');
    const tab = stack.locator('[role="tab"][data-origin="board"]');
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await expect(tab).toHaveAttribute('data-terminal-name', 'weather-bot');
    await expect(tab).toHaveAccessibleName(/board terminal/);
    // Keystrokes go to the terminal, so there is no command line, only the note.
    await expect(stack.locator('[data-command-line]')).toHaveCount(0);
    await expect(stack.locator('[data-board-note]')).toContainText('keys go straight to it');

    const xterm = stack.locator('[data-xterm][data-input]');
    await expect(xterm).toHaveAttribute('data-renderer', 'dom');
    const rows = xterm.locator('.xterm-rows');
    await expect(rows).toContainText('weather-bot $');
    await stack.getByRole('button', { name: 'Type in the terminal' }).click();
    await page.keyboard.type('echo hello-board');
    await page.keyboard.press('Enter');
    await expect(rows).toContainText(/echo hello-board\s*hello-board/);

    // Ctrl+C reaches the shell and stops what runs; Esc stays in the terminal too.
    await page.keyboard.type('pnpm dev');
    await page.keyboard.press('Enter');
    await expect(rows).toContainText('Local:');
    await page.keyboard.press('Escape');
    await expect(stack).toBeVisible();
    await page.keyboard.press('Control+C');
    await expect(rows).toContainText('^C');

    // A UI reconnect keeps the terminal and replays its output.
    await page.reload();
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await expect(rows).toContainText('hello-board');
    await xterm.click();
    await page.keyboard.type('exit 4');
    await page.keyboard.press('Enter');
    await expect(tab.locator('[data-exit="4"]')).toBeVisible();
    await expect(stack.locator('[data-board-note]')).toContainText('has ended');
  } finally {
    await context.close();
  }
});

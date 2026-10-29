import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type DemoBoard, startBoard } from './board.js';
import { expect, sessionHeader, signedInState, test } from './fixtures.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// `pnpm board` (10.9e): the server runs from its build, without a watcher. `pnpm e2e` has built
// the web app; the server is bundled here.
test('the built server serves the built app', async ({ browser }) => {
  test.slow();
  await promisify(execFile)('pnpm', ['--filter', '@yardmaster/server...', 'build'], { cwd: ROOT });
  let board: DemoBoard | undefined;
  try {
    board = await startBoard({ demo: true, built: true });
    const context = await browser.newContext({
      baseURL: board.url,
      storageState: signedInState(board.url, board.session),
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/#/');
    await expect(page).toHaveTitle(/Yardmaster/);
    await expect(page.locator('a[href^="#/p/"]').first()).toBeVisible();
    const status = await page.request.get('/api/status', { headers: sessionHeader(board.session) });
    expect(await status.json()).toMatchObject({ ok: true, demo: true, watched: false });
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await board?.stop();
  }
});

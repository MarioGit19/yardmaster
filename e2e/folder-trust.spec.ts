import { type DemoBoard, startDemoBoard } from './board.js';
import { expect, signedInState, test } from './fixtures.js';

// Folder trust: the demo's `cloned-tool` folder has Claude settings that run a SessionStart
// hook and pre-approve tools (apps/server/src/demo/library.ts). Its own board: it adds a project
// and trusts a folder, which the shared board's other specs shouldn't see.

let board: DemoBoard;

test.beforeAll(async () => {
  board = await startDemoBoard();
});

test.afterAll(async () => {
  await board?.stop();
});

test('a board session in an untrusted folder waits for the trust card', async ({ browser }) => {
  test.slow();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.session),
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto('/#/');
    await expect(page.locator('a[href^="#/p/"]').first()).toBeVisible();

    // Open it from the library with a Claude session: the card comes up before anything starts.
    await page.locator('[data-hud="open-project"]').click();
    const picker = page.locator('[data-open-project]');
    await picker.locator('[data-library-entry="cloned-tool"]').click();
    const sheet = picker.locator('[data-launch-sheet="cloned-tool"]');
    await sheet.locator('[data-launch-option="editor"] label').click();
    await sheet.locator('[data-launch-option="claude"] label').click();
    await sheet.getByRole('textbox', { name: 'What should Claude do?' }).fill('Read the README');
    await sheet.getByRole('button', { name: 'Open project' }).click();

    const card = page.getByRole('dialog', { name: 'Trust cloned-tool?' });
    await expect(card).toBeVisible();
    await expect(card.locator('[data-trust-path]')).toHaveText('/home/dev/cloned-tool');
    await expect(card.locator('[data-trust-group="hook"]')).toContainText('SessionStart hook');
    await expect(card.locator('[data-trust-group="hook"]')).toContainText(
      './scripts/bootstrap.sh --quiet',
    );
    await expect(card.locator('[data-trust-group="allow"]')).toContainText('Bash(npm run *)');
    await expect(card.locator('[data-trust-group="mode"]')).toContainText('acceptEdits');
    await expect(card.locator('[data-trust-group="mcp"]')).toContainText(
      'npx -y issue-tracker-mcp',
    );
    // Variable names, never their values.
    await expect(card.locator('[data-trust-group="env"]')).toContainText('NODE_OPTIONS');
    await expect(card).not.toContainText('register.js');

    // Cancel: nothing started; the project is open without a session.
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText('Not started: the folder is not trusted')).toBeVisible();
    await expect(page).toHaveURL(/#\/p\/[^/]+$/);
    await expect(page.locator('[data-session-panel]')).toHaveCount(0);

    // A new session from the workspace asks again; trusting starts it.
    await page.locator('[data-new-session]').click();
    const input = page
      .locator('[data-new-session-panel]')
      .getByRole('textbox', { name: 'First message for a new session' });
    await input.fill('Read the README');
    await input.press('Enter');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Trust and start' }).click();
    await expect(card).toHaveCount(0);
    await expect(page).toHaveURL(/#\/p\/[^/]+\/s\/[^/]+$/);
    const sessionId = decodeURIComponent(page.url().split('/s/')[1] ?? '');
    const session = page.locator(`[data-session-panel="${sessionId}"]`);
    await expect(session.locator('[data-message-list] [data-row="user"]').first()).toContainText(
      'Read the README',
    );

    // Trusted: the next session starts without asking.
    await page.locator('[data-new-session]').click();
    const next = page
      .locator('[data-new-session-panel]')
      .getByRole('textbox', { name: 'First message for a new session' });
    await next.fill('Now the tests');
    await next.press('Enter');
    await expect(page).not.toHaveURL(new RegExp(`/s/${sessionId}$`));
    await expect(page).toHaveURL(/#\/p\/[^/]+\/s\/[^/]+$/);
    await expect(card).toHaveCount(0);
  } finally {
    await context.close();
  }
});

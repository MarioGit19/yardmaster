import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectIdFromPath } from '../packages/protocol/src/project.js';
import { type DemoBoard, startBoard } from './board.js';
import {
  expect,
  firstProjectRoute,
  openRoute,
  sessionHeader,
  signedInState,
  test,
} from './fixtures.js';
import { OBSERVER_HOOK, runHook } from './local.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

test.describe('on the demo board', () => {
  const firstProject = async (page: import('@playwright/test').Page) => {
    await page.goto('/#/');
    return firstProjectRoute(page);
  };

  test('opens from the Changes tab and closes back to the project', async ({ page }) => {
    const project = await firstProject(page);
    await openRoute(page, project);
    await page.locator('[data-side-tab="changes"]').click();
    await page.locator('[data-review-open]').click();
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.locator('[data-review]')).toBeVisible();
    await page.locator('[data-review-close]').click();
    await expect(page.locator('[data-review]')).toHaveCount(0);
  });

  test('walks the files: viewed marks stick, split view, line counts', async ({ page }) => {
    const project = await firstProject(page);
    await openRoute(page, `${project}/review`);
    const files = page.locator('[data-review-file]');
    await expect(files.first()).toBeVisible({ timeout: 15_000 });
    const total = await files.count();
    await expect(page.locator('[data-review-diff] [data-diff-view="unified"]')).toBeVisible();
    await expect(page.locator('[data-review-totals]')).toContainText('+');

    await page.getByRole('button', { name: 'split', exact: true }).click();
    await expect(page.locator('[data-review-diff] [data-diff-view="split"]')).toBeVisible();

    await page.locator('[data-review-mark]').click();
    await expect(page.locator('[data-review-viewed]')).toContainText(`1 of ${total} viewed`);
    await page.reload();
    await expect(page.locator('[data-review-viewed]')).toContainText(`1 of ${total} viewed`, {
      timeout: 15_000,
    });
  });

  test('lists a project’s worktree and reviews it on its own', async ({ page }) => {
    await page.goto('/#/');
    const pod = page.locator('[data-pod]').filter({ hasText: 'orbit-api' }).first();
    const href = await pod.locator('a[href^="#/p/"]').first().getAttribute('href');
    await openRoute(page, href?.slice(1) ?? '/');
    await page.locator('[data-side-tab="changes"]').click();
    await page.locator('[data-worktree]').click();
    await expect(page).toHaveURL(/\/review\/[^/]+$/);
    await expect(page.locator('[data-review-file="src/limits/token-bucket.ts"]')).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('reads a diff, comes back to the file list and commits', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.locator('a[href^="#/p/"]').first()).toBeAttached();
    // A demo project with something uncommitted; they gather changes as the demo runs.
    let route: string | undefined;
    await expect(async () => {
      const links = await page
        .locator('a[href^="#/p/"]')
        .evaluateAll((all) => all.map((link) => link.getAttribute('href')));
      for (const href of new Set(links)) {
        const id = /^#\/p\/([^/]+)/.exec(href ?? '')?.[1];
        const res = await page.request.get(`/api/projects/${id}/review`, {
          headers: sessionHeader(),
        });
        if (!res.ok()) continue;
        const review = (await res.json()) as { files: { uncommitted: boolean }[] };
        if (review.files.some((file) => file.uncommitted)) route = `/p/${id}`;
      }
      expect(route).toBeDefined();
    }).toPass({ timeout: 30_000 });

    await openRoute(page, `${route}/review`);
    await page.locator('[data-review-file] button').first().click();
    await expect(page.locator('[data-review-diff] [data-diff-view="unified"]')).toBeVisible();
    await page.locator('[data-review-back]').click();

    await page.locator('[data-review-commit] textarea').fill('chore: tidy up');
    await page.locator('[data-review-commit] button[type="submit"]').click();
    await expect(page.getByText(/^Committed/)).toBeVisible();
  });
});

test.describe('on a real repository with a worktree', () => {
  let board: DemoBoard;
  let root: string;
  let repo: string;
  let linked: string;

  const hook = (cwd: string, id: string) =>
    runHook(board, OBSERVER_HOOK, {
      hook_event_name: 'SessionStart',
      session_id: id,
      cwd,
      transcript_path: join(cwd, 'none.jsonl'),
      source: 'startup',
    });

  test.beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'yardmaster-e2e-review-')));
    repo = join(root, 'acme-shop');
    linked = join(root, 'acme-shop-tax');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Dev');
    git(repo, 'config', 'user.email', 'dev@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(repo, 'cart.ts'), 'export const total = 1;\n');
    await writeFile(join(repo, 'tax.ts'), 'export const rate = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'start');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/tax', linked);
    board = await startBoard({ demo: false });
    await hook(repo, '11111111-1111-4111-8111-111111111111');
    await hook(linked, '22222222-2222-4222-8222-222222222222');
  });

  test.afterAll(async () => {
    await board?.stop();
    await rm(root, { recursive: true, force: true });
  });

  test('groups the worktree, then reviews, discards and commits in it', async ({ browser }) => {
    test.slow();
    const context = await browser.newContext({
      baseURL: board.url,
      storageState: signedInState(board.url, board.session),
      viewport: { width: 1440, height: 900 },
    });
    try {
      const page = await context.newPage();
      await writeFile(join(linked, 'tax.ts'), 'export const rate = 2;\n');
      await writeFile(join(linked, 'stray.ts'), 'scratch\n');
      await writeFile(join(linked, 'notes.ts'), 'keep\n');
      await page.goto('/#/');

      // Both checkouts are on the board, the linked one marked and right behind its main one.
      const mark = page.locator('[data-worktree-of]');
      await expect(mark).toBeVisible({ timeout: 20_000 });
      const pods = page.locator('[data-pod]');
      await expect(pods).toHaveCount(2);
      await expect(pods.nth(0)).toContainText('acme-shop');
      await expect(pods.nth(1).locator('[data-worktree-of]')).toHaveCount(1);

      await pods.nth(0).locator('a[href^="#/p/"]').first().click();
      await page.locator('[data-side-tab="changes"]').click();
      const worktree = page.locator('[data-worktree]');
      await expect(worktree).toContainText('fix/tax', { timeout: 20_000 });
      await worktree.click();

      await expect(page.locator('[data-review-base]')).toContainText('against main');
      await expect(page.locator('[data-review-file]')).toHaveCount(3);

      // Discard deletes the untracked file only, after asking.
      await page.locator('[data-review-file="stray.ts"] button').click();
      await page.locator('[data-review-discard]').click();
      await page.locator('[data-review-confirm]').getByRole('button', { name: 'Keep' }).click();
      await page.locator('[data-review-discard]').click();
      await page
        .locator('[data-review-confirm]')
        .getByRole('button', { name: 'Discard file' })
        .click();
      await expect(page.locator('[data-review-file]')).toHaveCount(2);
      expect(git(linked, 'status', '--porcelain').split('\n')).not.toContain('?? stray.ts');

      // A file changing under the review holds the commit back until the new diff is read.
      await writeFile(join(linked, 'tax.ts'), 'export const rate = 3;\n');
      await expect(page.locator('[data-review-stale]')).toBeVisible({ timeout: 15_000 });
      await page.locator('[data-review-stale] button').click();
      await expect(page.locator('[data-review-diff]')).toBeVisible();
      await page.locator('[data-review-file="tax.ts"] button').click();
      await expect(page.locator('[data-review-diff="tax.ts"]')).toContainText('rate = 3');

      await page.locator('[data-review-commit] textarea').fill('fix: settle the tax rate');
      await page.locator('[data-review-commit] button[type="submit"]').click();
      await expect(page.locator('[data-review-commit]')).toHaveCount(0, { timeout: 15_000 });

      expect(git(linked, 'log', '-1', '--format=%s').trim()).toBe('fix: settle the tax rate');
      expect(git(linked, 'status', '--porcelain').trim()).toBe('');
      expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('start');
      expect(await readFile(join(linked, 'tax.ts'), 'utf8')).toContain('rate = 3');
      // Committed work stays in the branch's review, without the actions that need a change.
      await expect(page.locator('[data-review-file="tax.ts"]')).toContainText('committed');
    } finally {
      await context.close();
    }
  });

  test('refuses a worktree the repository does not list', async ({ request }) => {
    const id = projectIdFromPath(repo);
    const res = await request.get(`${board.url}/api/projects/${id}/review?worktree=bbbbbbbbbbbb`, {
      headers: sessionHeader(board.session),
    });
    expect(res.status()).toBe(404);
  });
});

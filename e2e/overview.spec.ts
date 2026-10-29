import { expect, openRoute, sessionHeader, test } from './fixtures.js';

const COLUMNS = [
  { width: 390, height: 844, columns: 1 },
  { width: 1440, height: 900, columns: 3 },
  { width: 1920, height: 1080, columns: 4 },
] as const;

for (const { columns, ...viewport } of COLUMNS) {
  test(`the pod grid has ${columns} column(s) at ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openRoute(page, '/');
    const pods = page.locator('[data-pod]');
    await expect(pods.first()).toBeVisible();
    const lefts = await pods.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().left)),
    );
    expect(new Set(lefts).size).toBe(Math.min(columns, lefts.length));
  });
}

test('every pod has a header crew, session rows or a placeholder, and lanes', async ({ page }) => {
  await openRoute(page, '/');
  const pods = page.locator('[data-pod]');
  await expect(pods.first()).toBeVisible();
  for (const pod of await pods.all()) {
    await expect(pod.locator('header [data-crew]').first()).toBeVisible();
    await expect(pod.locator('[data-session], :text("No Claude sessions")').first()).toBeVisible();
  }
  await expect(page.locator('[data-session]').first()).toBeVisible();
  await expect(page.locator('[data-lane]').first()).toBeVisible();
});

test('a lane exit badge settles at full size', async ({ page }) => {
  await openRoute(page, '/');
  const badge = page.locator('[data-lane] [data-exit]').first();
  await expect(badge).toBeVisible();
  // Once the pop has settled the badge rests untransformed with a real box.
  await expect.poll(() => badge.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  const box = await badge.boundingBox();
  expect(box?.width).toBeGreaterThan(0);
  expect(box?.height).toBeGreaterThan(0);
});

test('a project waiting for approval moves to the front and glows amber', async ({ page }) => {
  test.slow();
  await openRoute(page, '/');
  // The demo's first permission request arrives 8–14 s in.
  const waiting = page.locator('[data-pod][data-tone="wait"]');
  await expect(waiting.first()).toBeVisible({ timeout: 30_000 });
  // Let the layout spring settle, then the first pod in the grid must be a waiting one.
  await page.waitForTimeout(800);
  const tones = await page.locator('[data-pod]').evaluateAll((els) =>
    els
      .map((el) => ({ tone: el.getAttribute('data-tone'), box: el.getBoundingClientRect() }))
      .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
      .map((p) => p.tone),
  );
  expect(tones[0]).toBe('wait');
  await expect(waiting.first().locator('[data-session]').first()).toContainText('Waiting');
});

test('a pod menu pins its project to the overview, and unpins it', async ({ page }) => {
  await openRoute(page, '/');
  const id = await page.locator('[data-pod]').first().getAttribute('data-pod');
  // By id: a project that starts waiting jumps to the front between the two menus.
  const pod = page.locator(`[data-pod="${id}"]`);
  const menu = page.locator(`[data-pod-menu="${id}"]`);
  const pinned = async () =>
    (await page.request.get('/api/settings', { headers: sessionHeader() }))
      .json()
      .then((s) => s.pinnedProjects as string[]);

  await pod.click({ button: 'right', position: { x: 24, y: 24 } });
  await menu.getByRole('menuitem', { name: 'Pin to the overview' }).click();
  await expect.poll(pinned).toContain(id);

  await pod.click({ button: 'right', position: { x: 24, y: 24 } });
  await menu.getByRole('menuitem', { name: 'Unpin from the overview' }).click();
  await expect.poll(pinned).not.toContain(id);
});

import { expect, type Locator, type Page } from '@playwright/test';
import { FOCUS_LAYOUTS, firstProjectRoute, openRoute, test } from './fixtures.js';

const open = async (page: Page) => {
  await openRoute(page, '/');
  await openRoute(page, await firstProjectRoute(page));
  const card = page.locator('[data-focus]');
  await expect(card).toBeVisible();
  return card;
};

/** Nothing inside `box` may stick out of the card or the viewport sideways. */
const expectInside = (page: Page, box: Locator, within: Locator) =>
  // Polled: the card is still morphing in for a moment.
  expect(async () => {
    const outer = await within.boundingBox();
    const inner = await box.boundingBox();
    if (!outer || !inner) throw new Error('nothing to measure');
    expect(inner.x).toBeGreaterThanOrEqual(outer.x - 0.5);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
    expect(inner.y + inner.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 0.5);
  }).toPass({ timeout: 5_000 });

/** The toggle's segments must all show in full: its row is the first thing to run out of room. */
const expectUnclipped = async (toggle: Locator) => {
  const clipped = await toggle.evaluate((el) => {
    const head = el.closest('header');
    if (!head) return 0;
    return head.scrollWidth - head.clientWidth;
  });
  expect(clipped).toBeLessThanOrEqual(0);
};

for (const layout of FOCUS_LAYOUTS) {
  test.describe(`${layout}: the chat comes first`, () => {
    test.use({ layout, viewport: { width: 1440, height: 900 } });

    test('the session list folds to a rail and stays folded', async ({ page }) => {
      const card = await open(page);
      const chat = card.locator('section[aria-label="Claude"]');
      const before = (await chat.boundingBox())?.width ?? 0;
      await card.locator('[data-session-list] a').first().waitFor();
      await card.locator('[data-rail-toggle]').click();
      await expect(card.locator('[data-session-rail]')).toBeVisible();
      await expect(card.locator('[data-session-list]')).toHaveCount(0);
      await expect.poll(async () => (await chat.boundingBox())?.width ?? 0).toBeGreaterThan(before);
      await expect(card.locator('[data-resize="left"]')).toHaveCount(0);
      await page.reload();
      await expect(card.locator('[data-session-rail]')).toBeVisible();
      await card.locator('[data-rail-toggle]').click();
      await expect(card.locator('[data-session-list]')).toBeVisible();
    });

    test('terminals and changes are tabs that remember, and fold away', async ({ page }) => {
      const card = await open(page);
      const stack = card.locator('[data-terminal-stack]');
      await expect(stack).toBeVisible();
      await card.locator('[data-side-tab="changes"]').click();
      await expect(card.locator('[data-side-panel] [data-git-panel]')).toBeVisible();
      await expect(stack).toBeHidden();
      await page.reload();
      await expect(card.locator('[data-side-panel] [data-git-panel]')).toBeVisible();
      await card.locator('[data-side-panel] [data-panel-toggle]').click();
      await expect(card.locator('[data-side-rail]')).toBeVisible();
      await card.locator('[data-side-open="terminals"]').click();
      await expect(stack).toBeVisible();
      await expect(card.locator('[data-side-rail]')).toHaveCount(0);
    });

    test('the header has no mascot, and names the branch and the status', async ({ page }) => {
      const card = await open(page);
      await expect(card.locator('header [data-focus-crew]')).toHaveCount(0);
      await expect(card.locator('h1')).toBeVisible();
      if (layout === 'minimal') {
        const head = card.locator('header').first();
        await expect(head.locator('[data-focus-branch]')).toBeVisible();
        await expect(head.locator('[data-status]')).toBeVisible();
      }
    });
  });
}

test.describe('a terminal asked for from elsewhere', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens the folded side panel', async ({ page }) => {
    const card = await open(page);
    const tab = card.locator('[data-terminal-stack] [role="tab"][data-tab]').first();
    await expect(tab).toBeAttached();
    const id = await card.getAttribute('data-focus');
    const terminal = await tab.getAttribute('data-tab');
    await card.locator('[data-side-panel] [data-panel-toggle]').click();
    await expect(card.locator('[data-side-rail]')).toBeVisible();
    await openRoute(page, `/p/${id}/t/${terminal}`);
    await expect(card.locator('[data-terminal-stack]')).toBeVisible();
  });
});

test.describe('transcript detail', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Summary drops the steps, Verbose opens them, and the pick is remembered', async ({
    page,
  }) => {
    const card = await open(page);
    const list = card.locator('section[aria-label="Claude"] [data-message-list]');
    const toggle = card.getByRole('radiogroup', { name: 'Transcript detail' });
    await expect(list).toBeVisible();
    await expect(list.locator('[data-row="tool"]').first()).toBeVisible();

    await toggle.getByRole('radio', { name: 'summary' }).click();
    await expect(list.locator('[data-row="thinking"]')).toHaveCount(0);
    await expect(list.locator('[data-tool-kind="read"], [data-tool-kind="bash"]')).toHaveCount(0);

    await toggle.getByRole('radio', { name: 'verbose' }).click();
    const done = list.locator('[data-tool][data-state="done"]').first();
    await expect(done).toHaveAttribute('data-open', '');

    await page.reload();
    await expect(toggle).toHaveAttribute('data-verbosity', 'verbose');
  });
});

for (const [width, height] of [
  [1280, 800],
  [1440, 900],
] as const) {
  test.describe(`nothing clips at ${width}`, () => {
    test.use({ viewport: { width, height } });

    for (const worst of [false, true]) {
      test(`${worst ? 'worst-case names' : 'demo data'}, with Verbose diffs`, async ({ page }) => {
        const query = worst ? '?worst=1' : '';
        await page.goto(`/${query}#/`);
        await page.goto(`/${query}#${await firstProjectRoute(page)}`);
        const card = page.locator('[data-focus]');
        await expect(card).toBeVisible();
        const chat = card.locator('section[aria-label="Claude"]');
        await chat.getByRole('radio', { name: 'verbose' }).click();
        await expectInside(page, chat.locator('header').first(), chat);
        await expectInside(page, card.locator('header').first(), card);
        await expectUnclipped(chat.getByRole('radiogroup', { name: 'Transcript detail' }));
        const composer = chat.locator('form, [data-terminal-approval], [data-fork-bar]').first();
        await expectInside(page, composer, chat);
        const diff = chat.locator('[data-tool-kind="edit"]').first();
        if ((await diff.count()) > 0) await expectInside(page, diff, chat);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  });
}

test.describe('the phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a chat page has the detail toggle, and the composer stays on screen', async ({ page }) => {
    const card = await open(page);
    await card
      .locator('[data-hub-item]')
      .filter({ hasText: /Claude/ })
      .first()
      .click();
    const chat = card.locator('[data-session-panel]');
    await expect(chat).toBeVisible();
    const toggle = chat.getByRole('radiogroup', { name: 'Transcript detail' });
    await toggle.getByRole('radio', { name: 'summary' }).click();
    await expect(toggle).toHaveAttribute('data-verbosity', 'summary');
    await expectInside(page, toggle, chat);
    await expectInside(
      page,
      chat.locator('form, [data-terminal-approval], [data-fork-bar]').first(),
      chat,
    );
  });
});

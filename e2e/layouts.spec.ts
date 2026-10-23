import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { startDemoBoard } from './board.js';
import { expect, openRoute, signedInState, test } from './fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

const layout = (page: Page) => page.locator('main [data-layout]:not([aria-hidden])');

test('the layout switches from shortcuts, ⌘K and Settings, and survives a reload', async ({
  page,
}) => {
  await openRoute(page, '/');
  await expect(layout(page)).toHaveAttribute('data-layout', 'minimal');
  await expect(page.locator('[data-pod]').first()).toBeVisible();

  // ⌥2: Office, the building, every character a button.
  await page.keyboard.press('Alt+Digit2');
  await expect(layout(page)).toHaveAttribute('data-layout', 'office');
  await expect(page.locator('[data-office-building]')).toBeVisible();
  await expect(page.locator('[data-room] [data-scene-actor]').first()).toBeVisible();
  await expect(page.locator('[data-pod]')).toHaveCount(0);

  await page.reload();
  await expect(layout(page)).toHaveAttribute('data-layout', 'office');

  // ⌘K: "Layout: Grid".
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.locator('[data-palette]');
  await expect(palette).toBeVisible();
  await page.keyboard.type('Layout: Grid');
  await expect(palette.getByRole('option', { name: /Layout: Grid/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(layout(page)).toHaveAttribute('data-layout', 'grid');

  // Settings → Appearance → Layout.
  await openRoute(page, '/settings');
  const row = page.locator('[data-setting="layout"]');
  await expect(row.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true');
  await row.getByRole('button', { name: 'Transit' }).click();
  await openRoute(page, '/');
  await expect(layout(page)).toHaveAttribute('data-layout', 'transit');

  // ⌥1 back to the pods.
  await page.keyboard.press('Alt+Digit1');
  await expect(layout(page)).toHaveAttribute('data-layout', 'minimal');
  await expect(page.locator('[data-pod]').first()).toBeVisible();
});

test('a terminal deep link opens the focus view on that terminal', async ({ page }) => {
  await openRoute(page, '/');
  const lane = page.locator('[data-pod] [data-lane][data-terminal-name="zsh"]').first();
  const terminalId = await lane.getAttribute('data-lane');
  const projectId = await lane.locator('xpath=ancestor::*[@data-pod][1]').getAttribute('data-pod');
  if (!terminalId || !projectId) throw new Error('no zsh lane in the demo');
  await openRoute(page, `/p/${encodeURIComponent(projectId)}/t/${encodeURIComponent(terminalId)}`);
  const tab = page.locator(`[data-terminal-stack] [role="tab"][data-terminal-name="zsh"]`);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
});

/** A demo board of the test's own: these tests stop terminals and decide requests. */
async function openBoard(
  browser: Browser,
  options: BrowserContextOptions = { viewport: { width: 1440, height: 900 } },
): Promise<{ page: Page; stop(): Promise<void> }> {
  const board = await startDemoBoard();
  const context = await browser.newContext({
    ...options,
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
  });
  const stop = async () => {
    await context.close();
    await board.stop();
  };
  try {
    const page = await context.newPage();
    await openRoute(page, '/');
    return { page, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

test.describe('the actor inspector on Minimal', () => {
  test('a terminal: keyboard, Focus in Cursor, Ctrl+C and Open', async ({ browser }) => {
    const { page, stop } = await openBoard(browser);
    try {
      const lane = page.locator('[data-lane][data-terminal-name="next dev"]').first();
      const trigger = lane.locator('[data-inspect]');
      const terminalId = await lane.getAttribute('data-lane');
      // The dev server serves on its port.
      const inspector = page.locator('[data-actor-inspector]');

      // Keyboard: Enter opens it with focus inside, Esc closes it back onto the trigger.
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(inspector).toBeVisible();
      await expect(inspector).toContainText('Terminal · acme-shop');
      await expect(inspector.locator('[data-actor-state="serving"]')).toBeVisible({
        timeout: 15_000,
      });
      await expect(inspector.locator('[data-port="3000"]')).toBeVisible();
      await expect(inspector.getByRole('log')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await trigger.click();
      await inspector.getByRole('button', { name: /^Focus in / }).click();
      await page.waitForTimeout(300);
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);

      await inspector.getByRole('button', { name: 'Ctrl+C' }).click();
      await expect(inspector.locator('[data-actor-state="serving"]')).toHaveCount(0);
      await expect(inspector.getByRole('button', { name: 'Ctrl+C' })).toHaveCount(0);

      await inspector.getByRole('link', { name: 'Open' }).click();
      await expect(inspector).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/t/${terminalId}$`));
      await expect(
        page.locator('[data-terminal-stack] [role="tab"][data-terminal-name="next dev"]'),
      ).toHaveAttribute('aria-selected', 'true');
    } finally {
      await stop();
    }
  });

  test('a waiting session: Allow from the inspector', async ({ browser }) => {
    test.slow();
    const { page, stop } = await openBoard(browser);
    try {
      // The demo's first permission request arrives 8–14 s in.
      const row = page.locator('[data-session]').filter({ hasText: 'Waiting for approval' });
      await expect(row.first()).toBeVisible({ timeout: 30_000 });
      const sessionId = await row.first().getAttribute('data-session');
      await row.first().locator('[data-inspect]').click();
      const inspector = page.locator('[data-actor-inspector]');
      await expect(inspector.locator('[data-actor-state="waiting"]')).toBeVisible();
      await expect(inspector.getByRole('link', { name: 'Open' })).toHaveAttribute(
        'href',
        new RegExp(`/s/${sessionId}$`),
      );
      await inspector.getByRole('button', { name: 'Allow' }).click();
      await expect(inspector.locator('[data-actor-state="waiting"]')).toHaveCount(0);
      await expect(inspector.getByRole('button', { name: 'Allow' })).toHaveCount(0);
    } finally {
      await stop();
    }
  });

  test('on a touch phone it is a bottom sheet that closes with a pull down', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const trigger = page.locator('[data-session] [data-inspect]').first();
      await trigger.tap();
      const sheet = page.locator('[data-actor-inspector][data-sheet]');
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('[data-actor]')).toContainText('Claude');
      // Once its spring settles, the bottom of the sheet sits on the bottom of the screen.
      await expect
        .poll(async () => {
          const b = await sheet.boundingBox();
          return b ? Math.round(b.y + b.height) : null;
        })
        .toBe(844);
      const box = await sheet.boundingBox();
      if (!box) throw new Error('the sheet has no box');
      // Pull the handle down.
      const x = box.x + box.width / 2;
      const y = box.y + 12;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + i * 25);
      await page.mouse.up();
      await expect(sheet).toHaveCount(0);
    } finally {
      await stop();
    }
  });
});

/** Projects showing each attention cue: pods in Minimal, rooms (and their door lights) in Office. */
async function cues(page: Page, office: boolean) {
  const item = office ? '[data-room]' : '[data-pod]';
  const count = (selector: string) => page.locator(selector).count();
  return {
    wait: await count(`${item}[data-tone="wait"]`),
    err: await count(`${item}[data-tone="err"]`),
    ...(office && {
      doors: {
        wait: await count('[data-room] [data-kit-door="wait"]'),
        err: await count('[data-room] [data-kit-door="err"]'),
      },
    }),
  };
}

test.describe('the Office building', () => {
  test('shows the same amber and rose cues as Minimal', async ({ browser }) => {
    test.slow();
    const { page, stop } = await openBoard(browser);
    try {
      // The demo's first permission request arrives 8–14 s in.
      await expect(page.locator('[data-pod][data-tone="wait"]').first()).toBeVisible({
        timeout: 30_000,
      });
      // The board keeps moving: compare a Minimal snapshot with the Office one right after,
      // until both describe the same moment.
      await expect
        .poll(
          async () => {
            await page.keyboard.press('Alt+Digit1');
            await expect(layout(page)).toHaveAttribute('data-layout', 'minimal');
            await expect(page.locator('main [data-layout="office"]')).toHaveCount(0);
            const minimal = await cues(page, false);
            await page.keyboard.press('Alt+Digit2');
            await expect(layout(page)).toHaveAttribute('data-layout', 'office');
            await expect(page.locator('main [data-layout="minimal"]')).toHaveCount(0);
            const office = await cues(page, true);
            const same =
              minimal.wait === office.wait &&
              minimal.err === office.err &&
              office.doors?.wait === office.wait &&
              office.doors?.err === office.err;
            return same && minimal.wait > 0;
          },
          { timeout: 40_000, intervals: [500] },
        )
        .toBe(true);
      // The waiting session is a character with its hand up.
      await expect(
        page.locator('[data-room] [data-scene-actor][data-actor-state="waiting"]').first(),
      ).toBeVisible();
      // The ambient field steps out: the building draws its own sky.
      await expect(page.locator('[data-office-sky]')).toHaveCount(1);
      await expect(page.locator('[data-ambient]')).toHaveCount(0);
    } finally {
      await stop();
    }
  });

  test('a character opens the inspector and shows its name tag on hover', async ({ browser }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit2');
      const character = page.locator('[data-room] [data-scene-actor]').first();
      await expect(character).toBeVisible();
      const tag = character.locator('[data-office-tag]');
      await expect(tag).toHaveCSS('opacity', '0');
      // Rooms reorder and characters walk under a still pointer: point again until it shows.
      await expect
        .poll(async () => {
          await character.hover();
          await page.waitForTimeout(200);
          return tag.evaluate((el) => getComputedStyle(el).opacity);
        })
        .toBe('1');
      await character.click();
      const inspector = page.locator('[data-actor-inspector]');
      await expect(inspector.locator('[data-actor]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);
      await expect(character).toBeFocused();
    } finally {
      await stop();
    }
  });

  test('on a phone: one room per floor, characters pause off screen', async ({ browser }) => {
    const { page, stop } = await openBoard(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await page.evaluate(() => localStorage.setItem('cboard.layout', 'office'));
      await page.reload();
      await expect(page.locator('[data-office-building]')).toHaveAttribute('data-columns', '1');
      // No horizontal overflow: the building keeps its gutter.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const first = page.locator('[data-room]').first();
      const last = page.locator('[data-room]').last();
      await expect(first.locator('.crew:not([data-crew-paused])').first()).toBeAttached();
      await expect(last.locator('.crew').first()).toBeAttached();
      await expect(last.locator('.crew:not([data-crew-paused])')).toHaveCount(0);
      // Tap a character: the inspector is a bottom sheet.
      await first.locator('[data-scene-actor]').first().tap();
      await expect(page.locator('[data-actor-inspector][data-sheet]')).toBeVisible();
    } finally {
      await stop();
    }
  });
});

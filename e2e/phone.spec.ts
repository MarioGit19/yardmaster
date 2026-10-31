import { devices, type Page } from '@playwright/test';
import { expect, openRoute, test } from './fixtures.js';

// The phone shell (DESIGN.md §11) on an Android (Galaxy S-class) and an iPhone profile, in
// Chromium: every tab, a project's workspace, swiping its tabs, a reply with the viewport shrunk
// as by the on-screen keyboard, and back.
const { defaultBrowserType: _android, ...galaxy } = devices['Galaxy S24'];
const { defaultBrowserType: _ios, ...iPhone } = devices['iPhone 13'];
const PROFILES = [
  { name: 'android', device: { ...galaxy, viewport: { width: 412, height: 915 } } },
  { name: 'iphone', device: { ...iPhone, viewport: { width: 390, height: 844 } } },
] as const;

const TABS = [
  { tab: 'projects', hash: '#/projects', content: '[data-phone-projects]' },
  { tab: 'attention', hash: '#/attention', content: '[data-attention-page]' },
  { tab: 'pulse', hash: '#/pulse', content: 'main h1:text-is("Pulse")' },
  { tab: 'more', hash: '#/more', content: '[data-more="layout"]' },
  { tab: 'overview', hash: '#/', content: '[data-pod]' },
] as const;

const hash = (page: Page) => page.evaluate(() => location.hash || '#/');

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const profile of PROFILES) {
  test.describe(`phone shell on ${profile.name}`, () => {
    test.use(profile.device);
    const { width, height } = profile.device.viewport;

    test('the top bar and the tab bar replace the rail and the Pulse rail', async ({ page }) => {
      await openRoute(page, '/');
      await expect(page.locator('[data-phone-shell]')).toBeVisible();
      await expect(page.locator('nav[aria-label="Projects"]')).toHaveCount(0);
      await expect(page.locator('section[aria-label="Pulse"]')).toHaveCount(0);
      const top = page.locator('[data-phone-topbar]');
      await expect(top.getByRole('link', { name: 'Yardmaster overview' })).toBeVisible();
      await expect(top.locator('[data-counter]')).toHaveCount(3);
      await expect(top.getByRole('button', { name: 'Search' })).toBeVisible();
      // Theme, motion and Open project left the top bar for More and Projects.
      await expect(page.locator('[data-hud="open-project"], [data-hud="motion"]')).toHaveCount(0);

      const bar = page.locator('[data-tab-bar]');
      const box = await bar.boundingBox();
      expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(height);
      expect(Math.round(box?.width ?? 0)).toBe(width);
      // Every tab is a thumb-sized target.
      for (const link of await bar.getByRole('link').all()) {
        const b = await link.boundingBox();
        expect(b?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(b?.height ?? 0).toBeGreaterThanOrEqual(44);
      }

      // ⌘K opens as a bottom sheet.
      await top.getByRole('button', { name: 'Search' }).tap();
      const palette = page.locator('[data-palette][data-sheet]');
      await expect(palette).toBeVisible();
      // Once its spring settles, the sheet sits on the bottom of the screen.
      await expect
        .poll(async () => {
          const sheet = await palette.boundingBox();
          return Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0));
        })
        .toBe(height);
      await page.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);
    });

    test('moves through every tab, with deep links and browser back', async ({ page }) => {
      await openRoute(page, '/');
      const bar = page.locator('[data-tab-bar]');
      for (const { tab, hash: target, content } of TABS) {
        await bar.locator(`[data-tab="${tab}"]`).tap();
        await expect.poll(() => hash(page)).toBe(target);
        await expect(bar.locator(`[data-tab="${tab}"]`)).toHaveAttribute('aria-current', 'page');
        await expect(page.locator(content).first()).toBeVisible();
        await expect(bar.locator('[data-tab-indicator]')).toHaveCount(1);
        await noSideScroll(page);
      }
      // Back walks the tabs in reverse.
      await page.goBack();
      await expect.poll(() => hash(page)).toBe('#/more');
      await expect(bar.locator('[data-tab="more"]')).toHaveAttribute('aria-current', 'page');
      // A deep link opens its tab; Settings sits under More.
      await page.goto('/#/settings');
      await expect(bar.locator('[data-tab="more"]')).toHaveAttribute('aria-current', 'page');
      await page.goto('/#/pulse');
      await expect(bar.locator('[data-tab="pulse"]')).toHaveAttribute('aria-current', 'page');
    });

    test('a workspace: full-bleed, a hub, a reply above the keyboard, and back', async ({
      page,
    }) => {
      test.slow();
      await openRoute(page, '/projects');
      const row = page.locator('[data-phone-project]').first();
      const id = await row.getAttribute('data-phone-project');
      if (!id) throw new Error('project row without an id');
      await row.tap();

      const workspace = page.locator(`[data-focus="${id}"][data-workspace="phone"]`);
      await expect(workspace).toBeVisible();
      // The bars leave; the workspace has the whole screen and its own app bar.
      await expect(page.locator('[data-tab-bar]')).toHaveCount(0);
      await expect(page.locator('[data-phone-topbar]')).toHaveCount(0);
      await expect
        .poll(async () => {
          const b = await workspace.boundingBox();
          return [b?.x, b?.y, b?.width, b?.height].map((n) => Math.round(n ?? -1));
        })
        .toEqual([0, 0, width, height]);
      const appBar = workspace.locator('[data-workspace-appbar]');
      await expect(appBar.getByRole('button', { name: 'Back' })).toBeVisible();
      await expect(appBar.locator('h1')).not.toBeEmpty();

      // The overflow menu is a bottom sheet with the full path.
      await appBar.locator('[data-workspace-menu-trigger]').tap();
      const menu = page.locator('[data-workspace-menu][data-sheet]');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Copy path' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // The project hub lists everything; a session's card opens its chat full screen.
      const hub = workspace.locator('[data-hub]');
      await expect(hub.locator('[data-hub-summary]')).toBeVisible();
      await hub.locator('[data-hub-kind="session"]').first().tap();
      const chat = workspace.locator('[data-workspace-page="item"]');
      await expect(chat.locator('[data-session-panel]')).toBeVisible();
      await chat.locator('[data-workspace-back]').tap();
      await expect(hub).toBeVisible();

      // + New, Claude session: a blank chat whose composer always takes text.
      await hub.locator('[data-hub-new]').tap();
      await page.locator('[data-new-claude]').tap();
      const item = workspace.locator('[data-workspace-page="new"]');

      // The keyboard takes the bottom of the screen: the field and Send stay in view.
      const composer = item.locator('[data-composer]').first();
      const field = composer.locator('textarea');
      await field.tap();
      const keyboard = Math.round(height * 0.45);
      await page.setViewportSize({ width, height: height - keyboard });
      await field.fill('Run the checks again and tell me what failed.');
      const send = composer.locator('button[type="submit"]');
      for (const target of [field, send]) {
        await expect(target).toBeInViewport({ ratio: 1 });
        const b = await target.boundingBox();
        expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThanOrEqual(height - keyboard);
      }
      await field.fill('');
      await page.setViewportSize({ width, height });
      // Back from the item is the hub.
      await item.locator('[data-workspace-back]').tap();
      await expect(hub).toBeVisible();

      // Back returns to the tab it was opened from, and the bars come back.
      await appBar.getByRole('button', { name: 'Back' }).tap();
      await expect.poll(() => hash(page)).toBe('#/projects');
      await expect(page.locator('[data-tab-bar] [data-tab="projects"]')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(workspace).toHaveCount(0);

      // So does the browser's back (the back gesture).
      await page.locator(`[data-phone-project="${id}"]`).tap();
      await expect(workspace).toBeVisible();
      await page.goBack();
      await expect.poll(() => hash(page)).toBe('#/projects');
      await expect(page.locator('[data-tab-bar]')).toBeVisible();
    });

    test('the Attention tab is the Attention Center; the waiting count opens it', async ({
      page,
    }) => {
      await openRoute(page, '/');
      await page.locator('[data-phone-topbar] [data-hud="needs-you"]').tap();
      await expect.poll(() => hash(page)).toBe('#/attention');
      await expect(page.locator('[data-attention-page] #attention-title')).toBeVisible();
      // No desktop sheet on a phone.
      await expect(page.locator('aside[aria-labelledby="attention-title"]')).toHaveCount(0);
    });
  });
}

test.describe('768 to 1023 px', () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test('keeps the desktop shell with the rail as icons', async ({ page }) => {
    await openRoute(page, '/');
    await expect(page.locator('[data-phone-shell]')).toHaveCount(0);
    await expect(page.locator('nav[aria-label="Projects"]')).toHaveAttribute(
      'data-collapsed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toHaveCount(0);
  });
});

for (const { name, device } of PROFILES) {
  test.describe(`usage on ${name}`, () => {
    test.use(device);

    test('the top bar and More show the limits', async ({ page }) => {
      await openRoute(page, '/more');
      await expect(page.locator('[data-phone-topbar] [data-hud="usage"]')).toBeVisible();
      const list = page.locator('[data-more="usage"]');
      await expect(list.locator('[data-usage="sevenDay"]')).toContainText('resets at');
      await expect(page.getByText(/^as of /)).toBeVisible();
      await noSideScroll(page);
    });
  });
}

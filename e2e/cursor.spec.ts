import type { Page } from '@playwright/test';
import { startDemoBoard } from './board.js';
import { expect, firstProjectRoute, openRoute, signedInState, test } from './fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * Every visible element that can be clicked (a click handler, an interactive role or a natively
 * interactive tag) whose computed cursor is still the arrow. Elements marked
 * `data-cursor="default"` keep the arrow on purpose.
 */
function arrowClickables(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const INTERACTIVE = [
      'button',
      'a[href]',
      'summary',
      'select',
      'label[for]',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="radio"]',
    ].join(',');
    const hasClickHandler = (el: Element) => {
      const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
      const props = key ? (el as unknown as Record<string, Record<string, unknown>>)[key] : null;
      return typeof props?.onClick === 'function';
    };
    const label = (el: Element) => {
      const attrs = ['data-hud', 'data-command', 'aria-label', 'role', 'class']
        .map((name) => el.getAttribute(name))
        .filter(Boolean)
        .map((v) => String(v).slice(0, 60));
      const text = (el.textContent ?? '').trim().slice(0, 30);
      return `<${el.tagName.toLowerCase()}> ${attrs.join(' | ')} "${text}"`;
    };
    const offenders: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      if (!el.matches(INTERACTIVE) && !hasClickHandler(el)) continue;
      if (el.closest('[data-cursor="default"], [inert], [aria-hidden="true"]')) continue;
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') {
        continue;
      }
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
      if (style.cursor === 'auto' || style.cursor === 'default') offenders.push(label(el));
    }
    return offenders;
  });
}

test('the overview, Pulse and HUD show the pointer on everything clickable', async ({ page }) => {
  await openRoute(page, '/');
  await expect(page.locator('[data-pod]').first()).toBeVisible();
  expect(await arrowClickables(page)).toEqual([]);
});

test('the focus view shows the pointer on everything clickable', async ({ page }) => {
  await openRoute(page, '/');
  await openRoute(page, await firstProjectRoute(page));
  await expect(page.locator('[data-focus]')).toBeVisible();
  expect(await arrowClickables(page)).toEqual([]);
});

test('the palette and settings show the pointer on everything clickable', async ({ page }) => {
  await openRoute(page, '/');
  await page.keyboard.press('ControlOrMeta+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  expect(await arrowClickables(page)).toEqual([]);
  await page.keyboard.press('Escape');

  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await arrowClickables(page)).toEqual([]);
});

test('the approvals sheet shows the pointer on everything clickable', async ({ browser }) => {
  test.slow();
  // Its own board, so opening a request never races the shared one.
  const board = await startDemoBoard();
  const context = await browser.newContext({
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await context.newPage();
    await openRoute(page, '/');
    const waiting = page.locator('[data-hud="waiting"]');
    await expect(waiting.locator('[data-value]')).not.toHaveAttribute('data-value', '0', {
      timeout: 30_000,
    });
    await waiting.click();
    const sheet = page.getByRole('complementary', { name: /Needs you/ });
    await expect(sheet.locator('article[data-approval]').first()).toBeVisible();
    expect(await arrowClickables(page)).toEqual([]);
  } finally {
    await context.close();
    await board.stop();
  }
});

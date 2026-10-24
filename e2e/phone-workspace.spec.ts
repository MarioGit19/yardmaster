import { devices, type Locator, type Page } from '@playwright/test';
import { type DemoBoard, startDemoBoard } from './board.js';
import { expect, openRoute, signedInState, test } from './fixtures.js';

// 12.6e4: the phone workspace as a project hub (DESIGN.md §11) on an Android (412) and an iPhone
// (390) profile: every reachability path in at most two taps from the overview, the switcher and
// swipes between items, one card per Claude terminal, words on every button, deep links with the
// hub underneath, the first-visit hint and a board terminal's key bar.
const { defaultBrowserType: _android, ...galaxy } = devices['Galaxy S24'];
const { defaultBrowserType: _ios, ...iPhone } = devices['iPhone 13'];
const PROFILES = [
  { name: 'android', device: { ...galaxy, viewport: { width: 412, height: 915 } } },
  { name: 'iphone', device: { ...iPhone, viewport: { width: 390, height: 844 } } },
] as const;

const hash = (page: Page) => page.evaluate(() => location.hash || '#/');

/** The WebGL renderer draws text into a canvas; the DOM fallback keeps output readable here. */
const NO_WEBGL = () => {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
    return String(args[0]).startsWith('webgl')
      ? null
      : (getContext.apply(this, args as Parameters<typeof getContext>) as never);
  } as typeof getContext;
};

/** A real touch swipe across `x0 → x1` at height `y` (CDP touch events, as a finger sends). */
async function swipe(page: Page, y: number, x0: number, x1: number) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 3;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/**
 * Every visible button or link on screen that shows no words. Allowed: the back arrow and the
 * overflow ⋮ (DESIGN.md §11), and what lives inside a terminal's own output.
 */
async function iconOnlyButtons(page: Page, scope = 'body'): Promise<string[]> {
  return page.evaluate((scope) => {
    const found: string[] = [];
    const root = document.querySelector(scope) ?? document.body;
    const targets = root.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], [role="tab"]',
    );
    for (const el of targets) {
      if (el.closest('.xterm, [inert], [aria-hidden="true"]')) continue;
      if (el.matches('[data-workspace-back], [data-workspace-menu-trigger], [data-sheet-handle]'))
        continue;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      if (box.bottom <= 0 || box.top >= innerHeight) continue;
      // biome-ignore lint/performance/useDomNodeTextContent: the words on screen, not hidden ones.
      if ((el.innerText ?? '').replace(/\s+/g, '').length > 0) continue;
      found.push(el.getAttribute('aria-label') ?? el.outerHTML.slice(0, 120));
    }
    return found;
  }, scope);
}

/** No icon-only button on screen, or inside the open sheet (`scope`) while one covers it. */
async function expectWordsOnEveryButton(page: Page, where: string, scope?: string) {
  expect(await iconOnlyButtons(page, scope), `icon-only buttons on ${where}`).toEqual([]);
}

/** Taps a pod's header on the phone overview: one tap, onto the project hub. */
async function openHubFromOverview(page: Page, pod: Locator) {
  await pod.locator('header a').first().tap();
  const hub = page.locator('[data-hub]');
  await expect(hub).toBeVisible();
  return hub;
}

for (const profile of PROFILES) {
  test.describe(`phone workspace on ${profile.name}`, () => {
    test.use(profile.device);
    const { width } = profile.device.viewport;

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(NO_WEBGL);
    });

    test('a chat, a terminal and a new terminal are each two taps from the overview', async ({
      page,
    }) => {
      test.slow();
      await openRoute(page, '/');
      const pod = page.locator('[data-pod]').first();
      const id = await pod.getAttribute('data-pod');

      // A session's chat: the pod, then its card.
      let hub = await openHubFromOverview(page, pod);
      await expect(hub.locator('[data-hub-summary]')).not.toBeEmpty();
      await hub.locator('[data-hub-kind="session"]').first().tap();
      const page2 = page.locator('[data-workspace-page="item"]');
      await expect(page2.locator('[data-session-panel]')).toBeVisible();
      await expectWordsOnEveryButton(page, 'a chat page');
      await page2.locator('[data-workspace-back]').tap();
      await expect.poll(() => hash(page)).toBe(`#/p/${id}`);
      await page.goBack();
      await expect(page.locator('[data-pod]').first()).toBeVisible();

      // A terminal's output: the pod, then a terminal card.
      hub = await openHubFromOverview(page, pod);
      await hub.locator('[data-hub-kind="terminal"]').first().tap();
      await expect(page2.locator('[data-terminal-item] .xterm-rows')).not.toBeEmpty();
      for (const word of ['Stop', 'Find', 'Clear']) {
        await expect(page2.getByRole('button', { name: word, exact: true })).toBeVisible();
      }
      await expectWordsOnEveryButton(page, 'a terminal page');
      await page.goBack();
      await expect(hub).toBeVisible();
      await expect(hub.locator('[data-hub-item][data-last]')).toHaveCount(1);
      await page.goBack();

      // A new terminal: the pod, then + New, whose sheet has Claude, a terminal and the chips.
      hub = await openHubFromOverview(page, pod);
      await hub.locator('[data-hub-new]').tap();
      const sheet = page.locator('[data-new-sheet]');
      await expect(sheet.locator('[data-new-claude]')).toBeVisible();
      await expect(sheet.locator('[data-command-chip="claude"]')).toBeVisible();
      await expectWordsOnEveryButton(page, 'the + New sheet', '[data-new-sheet]');
      // Its Claude session opens a blank chat whose composer says what happens, in words.
      await sheet.locator('[data-new-claude]').tap();
      const blank = page.locator('[data-workspace-page="new"]');
      await expect(blank.locator('[data-composer-state]')).toHaveText(
        'Claude starts when you send the first message.',
      );
      await expect(blank.getByRole('button', { name: 'Send' })).toHaveText('Send');
      await expectWordsOnEveryButton(page, 'the new session page');
      await blank.locator('[data-workspace-back]').tap();
      await expect(hub).toBeVisible();
      await hub.locator('[data-hub-new]').tap();
      await sheet.getByRole('button', { name: 'Open terminal' }).tap();
      await expect(sheet).toHaveCount(0);
      // The new terminal's page opens once it shows up.
      await expect.poll(() => hash(page), { timeout: 15_000 }).toMatch(/\/t\//);
      await expect(page2.locator('[data-terminal-item]')).toBeVisible();
    });

    test('a waiting approval is two taps from the overview', async ({ browser }) => {
      test.slow();
      const board = await startDemoBoard();
      const context = await browser.newContext({
        ...profile.device,
        baseURL: board.url,
        storageState: signedInState(board.url, board.cookie),
      });
      try {
        const page = await context.newPage();
        await openRoute(page, '/');
        // The demo's first permission request comes 8–14 s in.
        const pod = page.locator('[data-pod][data-tone="wait"]').first();
        await expect(pod).toBeVisible({ timeout: 30_000 });
        const hub = await openHubFromOverview(page, pod);
        const card = hub.locator('[data-hub-group="needs"] [data-hub-item]').first();
        await card.tap();
        await expect(page.locator('[data-workspace-page="item"] [data-approval]')).toBeVisible();
        await expect(
          page.locator('[data-workspace-page="item"]').getByRole('button', { name: /^Allow/ }),
        ).toBeVisible();
      } finally {
        await context.close();
        await board.stop();
      }
    });

    test('switches items with the switcher and by swiping; a Claude terminal is one card', async ({
      page,
    }) => {
      test.slow();
      await openRoute(page, '/');
      const pod = page.locator('[data-pod]').first();
      const id = await pod.getAttribute('data-pod');
      const hub = await openHubFromOverview(page, pod);

      // One card per Claude terminal: no terminal shows up twice.
      const terminals = await hub
        .locator('[data-hub-item]')
        .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-hub-terminal')));
      const named = terminals.filter(Boolean);
      expect(new Set(named).size).toBe(named.length);
      const claudeCard = hub.locator('[data-hub-kind="session"][data-hub-terminal]').first();
      await expect(claudeCard).toContainText('Claude in a terminal');
      await expectWordsOnEveryButton(page, 'the hub');

      // Its page has the Chat / Terminal toggle.
      const cards = await hub
        .locator('[data-hub-item]')
        .evaluateAll((all) => all.map((c) => c.getAttribute('data-hub-item')));
      await claudeCard.tap();
      const item = page.locator('[data-workspace-page="item"]');
      const view = item.locator('[data-item-view]');
      await expect(view.getByRole('button', { name: 'Chat' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await view.getByRole('button', { name: 'Terminal' }).tap();
      await expect(item.locator('[data-terminal-item]')).toBeVisible();
      await expectWordsOnEveryButton(page, 'a Claude terminal');
      await view.getByRole('button', { name: 'Chat' }).tap();
      await expect(item.locator('[data-session-panel]')).toBeVisible();

      // The switcher lists everything in the hub's groups.
      const current = await item.locator('[data-item-header]').getAttribute('data-item-header');
      await item.locator('[data-item-switch]').tap();
      const switcher = page.locator('[data-switcher-sheet]');
      // The same items as the hub under it (the shared demo board may have grown since).
      await expect
        .poll(
          async () =>
            (await switcher.locator('[data-switcher-item]').count()) -
            (await hub.locator('[data-hub-item]').count()),
        )
        .toBe(0);
      await expect(switcher.locator(`[data-switcher-item="${current}"]`)).toHaveAttribute(
        'aria-current',
        'true',
      );
      await expectWordsOnEveryButton(page, 'the switcher', '[data-switcher-sheet]');
      const other = cards.find((key) => key !== current) ?? '';
      await switcher.locator(`[data-switcher-item="${other}"]`).tap();
      await expect(switcher).toHaveCount(0);
      await expect(item.locator('[data-item-header]')).toHaveAttribute('data-item-header', other);

      // A swipe moves to the neighbouring item in the hub's order (read live: on the shared demo
      // board a card can change groups while the test runs).
      const header = item.locator('[data-item-header]');
      const live = () =>
        hub
          .locator('[data-hub-item]')
          .evaluateAll((all) => all.map((c) => c.getAttribute('data-hub-item') ?? ''));
      const adjacent = async (a: string, b: string) => {
        const keys = await live();
        return Math.abs(keys.indexOf(a) - keys.indexOf(b)) === 1;
      };
      // On the header: a terminal's output keeps sideways drags for itself.
      const area = await header.boundingBox();
      if (!area) throw new Error('no swipe area');
      const y = area.y + area.height / 2;
      const keys = await live();
      const forward = keys.indexOf(other) < keys.length - 1;
      const [x0, x1] = forward ? [width * 0.85, width * 0.15] : [width * 0.15, width * 0.85];
      await swipe(page, y, x0, x1);
      await expect(header).not.toHaveAttribute('data-item-header', other);
      const moved = (await header.getAttribute('data-item-header')) ?? '';
      expect(await adjacent(moved, other)).toBe(true);
      // And back the other way.
      await swipe(page, y, x1, x0);
      await expect(header).not.toHaveAttribute('data-item-header', moved);
      expect(await adjacent((await header.getAttribute('data-item-header')) ?? '', moved)).toBe(
        true,
      );

      // Moving between items replaces the entry: one back is the hub.
      await page.goBack();
      await expect.poll(() => hash(page)).toBe(`#/p/${id}`);
      await expect(hub).toBeVisible();
    });

    test('a deep link opens the item with the hub underneath; the pages have words', async ({
      page,
    }) => {
      test.slow();
      await openRoute(page, '/');
      const pod = page.locator('[data-pod]').first();
      const id = await pod.getAttribute('data-pod');
      const hub = await openHubFromOverview(page, pod);
      const href = await hub.locator('[data-hub-kind="terminal"]').first().getAttribute('href');
      if (!href) throw new Error('no terminal card');

      await page.goto(`/${href}`);
      await expect(page.locator('[data-workspace-page="item"] [data-terminal-item]')).toBeVisible();
      await expect(page.locator('[data-hub]')).toBeHidden();
      await page.goBack();
      await expect.poll(() => hash(page)).toBe(`#/p/${id}`);
      await expect(page.locator('[data-hub]')).toBeVisible();

      // Git, History and Ports open their own pages, and back returns to the hub.
      for (const row of ['git', 'history', 'ports'] as const) {
        await page.locator(`[data-hub-row="${row}"]`).tap();
        const sub = page.locator(`[data-workspace-page="${row}"]`);
        await expect(sub).toBeVisible();
        if (row === 'history') {
          await expect(sub.locator('[data-history]').first()).toBeVisible();
          await expect(sub.getByRole('button', { name: 'Resume here' }).first()).toBeVisible();
        }
        await expectWordsOnEveryButton(page, `the ${row} page`);
        await sub.locator('[data-workspace-back]').tap();
        await expect.poll(() => hash(page)).toBe(`#/p/${id}`);
      }
    });

    test('the first-visit hint goes away for good', async ({ page }) => {
      await openRoute(page, '/');
      const hub = await openHubFromOverview(page, page.locator('[data-pod]').first());
      const hint = hub.locator('[data-hub-hint]');
      await expect(hint).toContainText('Tap anything to open it. Tap its name to switch.');
      await hint.getByRole('button', { name: 'Got it' }).tap();
      await expect(hint).toHaveCount(0);
      await page.reload();
      await expect(page.locator('[data-hub]')).toBeVisible();
      await expect(page.locator('[data-hub-hint]')).toHaveCount(0);
    });
  });
}

test.describe('board terminal on a phone', () => {
  let board: DemoBoard;
  test.beforeAll(async () => {
    board = await startDemoBoard();
  });
  test.afterAll(async () => {
    await board?.stop();
  });

  test('has a key bar whose Ctrl reaches the shell', async ({ browser }) => {
    test.slow();
    const { width, height } = PROFILES[0].device.viewport;
    const context = await browser.newContext({
      ...PROFILES[0].device,
      viewport: { width, height },
      baseURL: board.url,
      storageState: signedInState(board.url, board.cookie),
    });
    await context.addInitScript(NO_WEBGL);
    try {
      const page = await context.newPage();
      await openRoute(page, '/projects');
      await page.locator('[data-phone-open-project]:visible').first().tap();
      const dialog = page.locator('[data-open-project]');
      await dialog.locator('[data-library-entry="weather-bot"]').tap();
      const sheet = dialog.locator('[data-launch-sheet="weather-bot"]');
      await sheet.locator('[data-launch-option="editor"] label').tap();
      await sheet.locator('[data-launch-option="terminal"] label').tap();
      await sheet.getByRole('button', { name: 'Open project' }).tap();
      await expect(dialog).toHaveCount(0);

      const hub = page.locator('[data-hub]');
      await expect(hub).toBeVisible();
      const card = hub.locator('[data-hub-kind="terminal"]').first();
      await expect(card).toBeVisible({ timeout: 10_000 });
      await card.tap();
      const item = page.locator('[data-workspace-page="item"]');
      const keys = item.getByRole('toolbar', { name: 'Terminal keys' });
      await expect(keys).toBeVisible();
      for (const key of ['Tab', 'Escape', 'Ctrl, for the next key', 'Up arrow']) {
        await expect(keys.getByRole('button', { name: key })).toBeVisible();
      }
      const rows = item.locator('[data-xterm][data-input] .xterm-rows');
      await expect(rows).toContainText('weather-bot $');
      await item.getByRole('button', { name: 'Type in the terminal' }).tap();
      await page.keyboard.type('pnpm dev');
      await page.keyboard.press('Enter');
      await expect(rows).toContainText('Local:');
      // Ctrl latches for the next key: c becomes Ctrl+C.
      const ctrl = keys.getByRole('button', { name: /^Ctrl/ });
      await ctrl.tap();
      await expect(ctrl).toHaveAttribute('aria-pressed', 'true');
      await page.locator('[data-xterm][data-input] textarea').focus();
      await page.keyboard.type('c');
      await expect(rows).toContainText('^C');
      await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
      await expectWordsOnEveryButton(page, 'a board terminal page');
    } finally {
      await context.close();
    }
  });
});

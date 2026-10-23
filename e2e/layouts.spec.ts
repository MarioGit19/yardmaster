import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { startDemoBoard } from './board.js';
import { disableWebgl, expect, openRoute, signedInState, test } from './fixtures.js';

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

/**
 * A demo board of the test's own: these tests stop terminals and decide requests. `init` runs
 * on the page before it first loads.
 */
async function openBoard(
  browser: Browser,
  options: BrowserContextOptions = { viewport: { width: 1440, height: 900 } },
  init?: (page: Page) => Promise<void>,
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
    await init?.(page);
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
      const any = page.locator('[data-room] [data-scene-actor]').first();
      await expect(any).toBeVisible();
      // Pinned by id: rooms reorder under a `.first()`.
      const actorId = await any.getAttribute('data-scene-actor');
      const character = page.locator(`[data-scene-actor="${actorId}"]`);
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

/** The building layer's scale, from its computed transform matrix. */
const buildingScale = (page: Page) =>
  page.locator('[data-office-building]').evaluate((el) => {
    const t = getComputedStyle(el).transform;
    return t === 'none' ? 1 : new DOMMatrixReadOnly(t).a;
  });

/**
 * Enters a room with a terminal in it, opens that terminal's inspector from the room's list,
 * opens the workspace and comes back with Esc to the same room view, then Esc to the building.
 */
async function roomViewRoundTrip(page: Page, touch: boolean) {
  await page.evaluate(() => localStorage.setItem('cboard.layout', 'office'));
  await page.reload();
  const office = page.locator('[data-office]');
  const room = page
    .locator('[data-room]', { has: page.locator('[data-scene-actor^="t:"]') })
    .first();
  await expect(room).toBeVisible();
  const roomId = await room.getAttribute('data-room');
  if (!roomId) throw new Error('no room with a terminal in the demo');
  const byId = page.locator(`[data-room="${roomId}"]`);
  const box = await byId.boundingBox();
  if (!box) throw new Error('the room has no box');
  // The ceiling, clear of every character and sign.
  const spot = { x: box.width / 2, y: 4 };
  if (touch) await byId.tap({ position: spot });
  else await byId.click({ position: spot });

  await expect(office).toHaveAttribute('data-office-entered', roomId);
  const panel = page.locator(`[data-office-room-panel="${roomId}"]`);
  await expect(panel).toBeVisible();
  if (touch) await expect(panel).toHaveAttribute('data-sheet', 'true');
  await expect(office).not.toHaveAttribute('data-office-moving', '');
  expect(await buildingScale(page)).toBeGreaterThan(touch ? 0.9 : 1.5);
  // The room fills the stage: on screen, and on a phone edge to edge.
  const zoomed = await byId.boundingBox();
  const stage = await page.locator('main').boundingBox();
  if (!zoomed || !stage) throw new Error('no box');
  expect(zoomed.x).toBeGreaterThanOrEqual(stage.x);
  expect(zoomed.x + zoomed.width).toBeLessThanOrEqual(stage.x + stage.width);
  expect(zoomed.y).toBeGreaterThanOrEqual(stage.y);
  if (touch) expect(zoomed.width).toBeGreaterThan(stage.width - 40);
  // Every other room steps back and is out of reach.
  await expect(page.locator('[data-office-cell][data-away]:not([inert])')).toHaveCount(0);

  // A terminal's inspector, from the list.
  const row = panel.locator('[data-room-actor-kind="terminal"]').first();
  if (touch) await row.tap();
  else await row.click();
  const inspector = page.locator(
    touch ? '[data-actor-inspector][data-sheet]' : '[data-actor-inspector]',
  );
  await expect(inspector.locator('[data-actor]')).toContainText('Terminal ·');
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  // Esc closed the inspector, not the room.
  await expect(office).toHaveAttribute('data-office-entered', roomId);

  // Open workspace: the focus view, then Esc back into the same room view.
  const open = panel.locator('[data-room-open]');
  if (touch) await open.tap();
  else await open.click();
  await expect(page).toHaveURL(new RegExp(`#/p/${encodeURIComponent(roomId)}$`));
  await expect(page.locator(`[data-focus="${roomId}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus]')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/$/);
  await expect(office).toHaveAttribute('data-office-entered', roomId);
  await expect(panel).toBeVisible();
  await expect(open).toBeFocused();

  // Esc again: back out to the building, keyboard focus on the room.
  await page.keyboard.press('Escape');
  await expect(office).not.toHaveAttribute('data-office-entered', /.+/);
  await expect(panel).toHaveCount(0);
  await expect(byId).toBeFocused();
  await expect.poll(() => buildingScale(page)).toBe(1);
  await expect(page.locator('[data-office-cell][data-away]')).toHaveCount(0);
}

test.describe('the Office room view', () => {
  test('desktop: enter, inspect a terminal, open the workspace, Esc back to the room', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await roomViewRoundTrip(page, false);
    } finally {
      await stop();
    }
  });

  test('touch phone: the room fills the screen, the list is a bottom sheet', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await roomViewRoundTrip(page, true);
    } finally {
      await stop();
    }
  });

  test('keyboard: Tab to a room, Enter, arrows to a character, Esc; Back leaves too', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit2');
      const office = page.locator('[data-office]');
      const first = page.locator('[data-room]').first();
      await expect(first).toBeVisible();
      // Characters aren't Tab stops; the room is.
      await expect(first.locator('[data-scene-actor]').first()).toHaveAttribute('tabindex', '-1');
      await first.focus();
      const roomId = await first.getAttribute('data-room');
      await page.keyboard.press('Tab');
      const next = await page.evaluate(() => document.activeElement?.getAttribute('data-room'));
      expect(next).toBeTruthy();
      expect(next).not.toBe(roomId);
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator(`[data-room="${roomId}"]`)).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(office).toHaveAttribute('data-office-entered', roomId ?? '');
      await page.keyboard.press('ArrowRight');
      await expect(page.locator(`[data-room="${roomId}"] [data-scene-actor]:focus`)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(office).not.toHaveAttribute('data-office-entered', /.+/);
      await expect(page.locator(`[data-room="${roomId}"]`)).toBeFocused();

      // The browser's back leaves the room view like Esc.
      await page.keyboard.press('Enter');
      await expect(office).toHaveAttribute('data-office-entered', roomId ?? '');
      await page.goBack();
      await expect(office).not.toHaveAttribute('data-office-entered', /.+/);
      await expect(page).toHaveURL(/#\/$/);
    } finally {
      await stop();
    }
  });
});

/** Projects showing each attention cue on the Grid: nodes, and the pipelines feeding them. */
async function gridCues(page: Page) {
  const count = (selector: string) => page.locator(selector).count();
  return {
    wait: await count('[data-grid-node][data-tone="wait"]'),
    err: await count('[data-grid-node][data-tone="err"]'),
    pipes: {
      wait: await count('[data-grid-pipe][data-tone="wait"]'),
      err: await count('[data-grid-pipe][data-tone="err"]'),
    },
  };
}

/** Packets in flight per activity step, as `packetFlow` in grid/map.ts. */
const PACKETS = ['0', '1', '2', '3'];

// Without WebGL: at Full motion a desktop otherwise shows the 3D network (below).
test.describe('the Grid map', () => {
  test('shows the same amber and rose cues as Minimal, on its own floor', async ({ browser }) => {
    test.slow();
    const { page, stop } = await openBoard(browser, undefined, disableWebgl);
    try {
      await expect(page.locator('[data-pod][data-tone="wait"]').first()).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(
          async () => {
            await page.keyboard.press('Alt+Digit1');
            await expect(layout(page)).toHaveAttribute('data-layout', 'minimal');
            await expect(page.locator('main [data-layout="grid"]')).toHaveCount(0);
            const minimal = await cues(page, false);
            await page.keyboard.press('Alt+Digit3');
            await expect(layout(page)).toHaveAttribute('data-layout', 'grid');
            await expect(page.locator('main [data-layout="minimal"]')).toHaveCount(0);
            const grid = await gridCues(page);
            const same =
              minimal.wait === grid.wait &&
              minimal.err === grid.err &&
              grid.pipes.wait === grid.wait &&
              grid.pipes.err === grid.err;
            return same && minimal.wait > 0;
          },
          { timeout: 40_000, intervals: [500] },
        )
        .toBe(true);
      // A waiting node raises its beacon; its waiting session is a satellite.
      await expect(
        page.locator('[data-grid-node][data-tone="wait"] [data-grid-beacon]').first(),
      ).toBeAttached();
      await expect(
        page.locator('[data-grid-node] [data-scene-actor][data-actor-state="waiting"]').first(),
      ).toBeVisible();
      await expect(page.locator('[data-grid-floor]')).toHaveCount(1);
      await expect(page.locator('[data-ambient]')).toHaveCount(0);
    } finally {
      await stop();
    }
  });

  test('packets follow activity, and nothing flashes faster than 3 Hz', async ({ browser }) => {
    test.slow();
    const { page, stop } = await openBoard(browser, undefined, disableWebgl);
    try {
      await page.keyboard.press('Alt+Digit3');
      await expect(page.locator('[data-grid-map]')).toBeVisible();
      // Each pipeline carries as many packets as its project's activity step asks for.
      const flowsMatch = () =>
        page
          .locator('[data-grid-pipe]')
          .evaluateAll(
            (pipes, wanted) =>
              pipes.every(
                (pipe) =>
                  String(pipe.querySelectorAll('[data-grid-packet]').length) ===
                  wanted[Number(pipe.getAttribute('data-step'))],
              ),
            PACKETS,
          );
      await expect.poll(flowsMatch).toBe(true);
      // Some project is busy: its pipeline is lit and packets travel on it.
      await expect(
        page.locator('[data-grid-pipe]:not([data-step="0"]) [data-grid-packet]').first(),
      ).toBeAttached({
        timeout: 20_000,
      });
      // An event fires a burst along its pipeline.
      await expect(page.locator('[data-grid-burst]').first()).toBeAttached({ timeout: 20_000 });

      // WCAG 2.3.1: every repeating animation in the Grid has a period of at least 1/3 s.
      const loops = await page.evaluate(() =>
        document.getAnimations().flatMap((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          if (!target?.closest('[data-grid]')) return [];
          const timing = animation.effect?.getComputedTiming();
          if (!timing || timing.iterations !== Number.POSITIVE_INFINITY) return [];
          return [{ duration: Number(timing.duration), rate: animation.playbackRate }];
        }),
      );
      expect(loops.length).toBeGreaterThan(0);
      for (const loop of loops)
        expect(loop.duration / Math.abs(loop.rate)).toBeGreaterThanOrEqual(1000 / 3);
    } finally {
      await stop();
    }
  });

  test('a satellite opens the inspector; a node opens its cockpit and Esc steps back', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser, undefined, disableWebgl);
    try {
      await page.keyboard.press('Alt+Digit3');
      const grid = page.locator('[data-grid]');
      const any = page
        .locator('[data-grid-node]', { has: page.locator('[data-scene-actor^="t:"]') })
        .first();
      await expect(any).toBeVisible();
      // Pinned by id: nodes reorder by attention under a `.first()`.
      const nodeId = await any.getAttribute('data-grid-node');
      const node = page.locator(`[data-grid-node="${nodeId}"]`);

      // A satellite: the inspector, and Esc gives focus back to it.
      const satellite = node.locator('[data-scene-actor^="t:"]').first();
      await expect(satellite).toHaveAttribute('tabindex', '-1');
      await satellite.click();
      const inspector = page.locator('[data-actor-inspector]');
      await expect(inspector.locator('[data-actor]')).toContainText('Terminal ·');
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);
      await expect(satellite).toBeFocused();
      await expect(grid).not.toHaveAttribute('data-grid-entered', /.+/);

      // Keyboard: Tab moves node to node, Enter opens the cockpit.
      await node.focus();
      await page.keyboard.press('Tab');
      const next = await page.evaluate(() =>
        document.activeElement?.getAttribute('data-grid-node'),
      );
      expect(next).toBeTruthy();
      expect(next).not.toBe(nodeId);
      await page.keyboard.press('Shift+Tab');
      await expect(node).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(node.locator('[data-scene-actor]:focus')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(node).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(grid).toHaveAttribute('data-grid-entered', nodeId ?? '');
      const cockpit = page.locator(`[data-grid-cockpit="${nodeId}"]`);
      await expect(cockpit).toBeVisible();
      await expect(page.locator('[data-grid-map]')).toHaveCount(0);
      // The Claude screen in the middle, terminal screens with their live tails, small screens.
      await expect(
        cockpit.locator('[data-grid-screen="terminal"] [data-peek]').first(),
      ).toBeVisible();
      for (const kind of ['git', 'ports', 'todo'])
        await expect(cockpit.locator(`[data-grid-screen="${kind}"]`)).toBeVisible();

      // Open workspace, then Esc back into the same cockpit.
      await cockpit.locator('[data-cockpit-open]').click();
      await expect(page.locator(`[data-focus="${nodeId}"]`)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-focus]')).toHaveCount(0);
      await expect(grid).toHaveAttribute('data-grid-entered', nodeId ?? '');
      await expect(cockpit.locator('[data-cockpit-open]')).toBeFocused();

      // Esc again: back on the network, focus on the node.
      await page.keyboard.press('Escape');
      await expect(grid).not.toHaveAttribute('data-grid-entered', /.+/);
      await expect(node).toBeFocused();

      // The browser's back leaves the cockpit like Esc.
      await page.keyboard.press('Enter');
      await expect(grid).toHaveAttribute('data-grid-entered', nodeId ?? '');
      await page.goBack();
      await expect(grid).not.toHaveAttribute('data-grid-entered', /.+/);
      await expect(page).toHaveURL(/#\/$/);
    } finally {
      await stop();
    }
  });

  test('at Reduced nothing travels: pipelines just light up', async ({ browser }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.evaluate(() => {
        localStorage.setItem('cboard.layout', 'grid');
        localStorage.setItem('cboard.motion', 'reduced');
      });
      await page.reload();
      await expect(page.locator('[data-grid-map]')).toBeVisible();
      await expect(page.locator('[data-grid-pipe]:not([data-step="0"])').first()).toBeAttached({
        timeout: 20_000,
      });
      await expect(
        page.locator('[data-grid-packet], [data-grid-burst], [data-grid-beckon], [data-grid-done]'),
      ).toHaveCount(0);
    } finally {
      await stop();
    }
  });

  test('on a touch phone: one trunk, 44 px satellites, the cockpit as a swipeable row', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await page.evaluate(() => localStorage.setItem('cboard.layout', 'grid'));
      await page.reload();
      const grid = page.locator('[data-grid]');
      await expect(grid).toHaveAttribute('data-grid-view', 'trunk');
      await expect(page.locator('[data-grid-trunk] [data-grid-pipe]').first()).toBeAttached();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const node = page
        .locator('[data-grid-node]', { has: page.locator('[data-scene-actor^="t:"]') })
        .first();
      const nodeId = await node.getAttribute('data-grid-node');
      const satellite = page.locator(`[data-grid-node="${nodeId}"] [data-scene-actor]`).first();
      const box = await satellite.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      await satellite.tap();
      const sheet = page.locator('[data-actor-inspector][data-sheet]');
      await expect(sheet).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);

      await page.locator(`[data-grid-node="${nodeId}"]`).tap({ position: { x: 100, y: 10 } });
      await expect(grid).toHaveAttribute('data-grid-entered', nodeId ?? '');
      const stack = page.locator(`[data-grid-cockpit="${nodeId}"] .grid-cockpit-stack`);
      await expect(stack).toBeVisible();
      // More screens than fit: the row scrolls sideways, one screen at a time.
      const scroll = await stack.evaluate((el) => ({
        width: el.scrollWidth,
        client: el.clientWidth,
        snap: getComputedStyle(el).scrollSnapType,
      }));
      expect(scroll.width).toBeGreaterThan(scroll.client);
      expect(scroll.snap).toContain('mandatory');
      await page.locator('[data-cockpit-back]').tap();
      await expect(grid).not.toHaveAttribute('data-grid-entered', /.+/);
      await expect(grid).toHaveAttribute('data-grid-view', 'trunk');
    } finally {
      await stop();
    }
  });
});

interface GridCamera {
  azimuth: number;
  polar: number;
  distance: number;
  home: number;
  dive: 'out' | 'diving' | 'in' | 'rising';
}

/** The 3D Grid's camera orbit, from the renderer's test hook on its stage. */
const camera = (page: Page) =>
  page
    .locator('[data-grid-3d]')
    .evaluate((el) => (el as unknown as { gridCamera(): GridCamera }).gridCamera());

test.describe('the Grid 3D network', () => {
  test('draws the network in one WebGL context, with the same cues as Minimal', async ({
    browser,
  }) => {
    test.slow();
    const { page, stop } = await openBoard(browser);
    try {
      await expect(page.locator('[data-pod][data-tone="wait"]').first()).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(
          async () => {
            await page.keyboard.press('Alt+Digit1');
            await expect(layout(page)).toHaveAttribute('data-layout', 'minimal');
            await expect(page.locator('main [data-layout="grid"]')).toHaveCount(0);
            const minimal = await cues(page, false);
            await page.keyboard.press('Alt+Digit3');
            await expect(page.locator('[data-grid-3d][data-ready]')).toBeVisible();
            await expect(page.locator('main [data-layout="minimal"]')).toHaveCount(0);
            const grid = await gridCues(page);
            return minimal.wait === grid.wait && minimal.err === grid.err && minimal.wait > 0;
          },
          { timeout: 40_000, intervals: [500] },
        )
        .toBe(true);
      await expect(page.locator('[data-grid]')).toHaveAttribute('data-grid-view', '3d');
      // One canvas, and the ambient field is gone: one WebGL context at a time.
      await expect(page.locator('canvas[data-grid-canvas]')).toHaveCount(1);
      await expect(page.locator('[data-ambient]')).toHaveCount(0);
      await expect(page.locator('[data-grid-floor]')).toHaveAttribute('data-grid-floor', '3d');
      // Every project has its label floating on screen, as crisp DOM text.
      const projects = await page.locator('a[href^="#/p/"]').count();
      await expect(page.locator('[data-grid-label] [data-grid-node]')).toHaveCount(projects);
      const stage = await page.locator('[data-grid-3d]').boundingBox();
      for (const label of await page.locator('[data-grid-label] [data-grid-node]').all()) {
        const box = await label.boundingBox();
        expect(box && stage && box.x >= stage.x - 1 && box.y >= stage.y - 1).toBe(true);
      }
    } finally {
      await stop();
    }
  });

  test('the camera drifts, stops under the pointer, turns on a drag and resets', async ({
    browser,
  }) => {
    test.slow();
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit3');
      const stage = page.locator('[data-grid-3d][data-ready]');
      await expect(stage).toBeVisible();
      await page.mouse.move(5, 5);
      // The idle orbit: about a revolution per three minutes.
      const start = await camera(page);
      await page.waitForTimeout(1_500);
      const drifted = (await camera(page)).azimuth - start.azimuth;
      expect(drifted).toBeGreaterThan(0.02);
      expect(drifted).toBeLessThan(0.15);

      // The pointer over the scene holds the camera still.
      const box = await stage.boundingBox();
      if (!box) throw new Error('no stage');
      const floor = { x: box.x + 60, y: box.y + box.height - 30 };
      await page.mouse.move(floor.x, floor.y);
      const held = await camera(page);
      await page.waitForTimeout(1_000);
      expect((await camera(page)).azimuth).toBe(held.azimuth);

      // A drag turns it (and tilts it, within limits); a double-click eases it home.
      await page.mouse.down();
      await page.mouse.move(floor.x + 300, floor.y - 400, { steps: 12 });
      await page.mouse.up();
      const turned = await camera(page);
      expect(Math.abs(turned.azimuth - held.azimuth)).toBeGreaterThan(1);
      expect(turned.polar).toBeGreaterThan(0.5);
      expect(turned.polar).toBeLessThan(1.4);
      await page.mouse.dblclick(floor.x, floor.y);
      await expect.poll(async () => (await camera(page)).azimuth).toBeCloseTo(0, 3);
      const home = await camera(page);
      expect(home.distance).toBeCloseTo(home.home, 3);

      // The wheel zooms within its clamps, and the page itself doesn't scroll.
      for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 400);
      await expect
        .poll(async () => {
          const { distance, home } = await camera(page);
          return distance / home;
        })
        .toBeCloseTo(1.6, 3);
      for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400);
      await expect
        .poll(async () => {
          const { distance, home } = await camera(page);
          return distance / home;
        })
        .toBeCloseTo(0.55, 3);
      expect(await page.locator('main').evaluate((el) => el.scrollTop)).toBe(0);
    } finally {
      await stop();
    }
  });

  test('a satellite opens the inspector; a label opens its cockpit and Esc comes back', async ({
    browser,
  }) => {
    test.slow();
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit3');
      const grid = page.locator('[data-grid]');
      await expect(page.locator('[data-grid-3d][data-ready]')).toBeVisible();
      const any = page
        .locator('[data-grid-node]', { has: page.locator('[data-scene-actor^="t:"]') })
        .first();
      const nodeId = await any.getAttribute('data-grid-node');
      const node = page.locator(`[data-grid-node="${nodeId}"]`);
      // Hold the camera still so the satellites hold still too.
      await page.mouse.move(400, 500);

      // The satellite's button rides over its 3D satellite: a click opens the inspector.
      const satellite = node.locator('[data-scene-actor^="t:"]').first();
      await satellite.click();
      const inspector = page.locator('[data-actor-inspector]');
      await expect(inspector.locator('[data-actor]')).toContainText('Terminal ·');
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);
      await expect(satellite).toBeFocused();

      // Keyboard: Esc back to the node, Enter dives into its cockpit, Esc rises back out.
      await page.keyboard.press('Escape');
      await expect(node).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(grid).toHaveAttribute('data-grid-entered', nodeId ?? '');
      await expect(page.locator(`[data-grid-cockpit="${nodeId}"]`)).toBeVisible();
      // The network stays behind the cockpit: still one canvas, one WebGL context.
      await expect(page.locator('canvas[data-grid-canvas]')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(grid).toHaveAttribute('data-grid-view', '3d');
      await expect(page.locator('[data-grid-3d]')).toHaveAttribute('data-grid-dive', 'out');
      await expect(page.locator(`[data-grid-node="${nodeId}"]`)).toBeFocused();
      await expect(page.locator('canvas[data-grid-canvas]')).toHaveCount(1);

      // A click on the label opens it too.
      await page.locator(`[data-grid-node="${nodeId}"]`).click({ position: { x: 100, y: 10 } });
      await expect(grid).toHaveAttribute('data-grid-entered', nodeId ?? '');
    } finally {
      await stop();
    }
  });

  test('dives into a node, runs a command on a centered terminal and backs out with Esc twice', async ({
    browser,
  }) => {
    test.slow();
    const { page, stop } = await openBoard(browser);
    try {
      const lane = page.locator('[data-pod] [data-lane][data-terminal-name="zsh"]').first();
      const terminalId = await lane.getAttribute('data-lane');
      const projectId = await lane
        .locator('xpath=ancestor::*[@data-pod][1]')
        .getAttribute('data-pod');
      if (!terminalId || !projectId) throw new Error('no zsh lane in the demo');
      await page.keyboard.press('Alt+Digit3');
      const grid = page.locator('[data-grid]');
      const stage = page.locator('[data-grid-3d][data-ready]');
      await expect(stage).toBeVisible();
      const start = await camera(page);
      expect(start.dive).toBe('out');

      // Enter on the node: the camera flies down its pipeline, the labels step out of the way.
      const node = page.locator(`[data-grid-node="${projectId}"]`);
      await node.focus();
      await page.keyboard.press('Enter');
      await expect(grid).toHaveAttribute('data-grid-entered', projectId);
      await expect(stage).toHaveAttribute('data-grid-dive', /diving|in/);
      await expect(page.locator('.grid-labels')).toHaveCSS('visibility', 'hidden');
      await expect(stage).toHaveAttribute('data-grid-dive', 'in');
      const inside = await camera(page);
      expect(inside.dive).toBe('in');

      // The cockpit phases in over the network, its screens real DOM in a 3D arc.
      const cockpit = page.locator(`[data-grid-cockpit="${projectId}"]`);
      await expect(cockpit).toBeVisible();
      await expect(cockpit).toHaveAttribute('data-deep', '');
      await expect(cockpit).toBeFocused();
      await expect(page.locator('canvas[data-grid-canvas]')).toHaveCount(1);
      await expect(cockpit.locator('[data-grid-screen="claude"]').first()).toBeVisible();
      for (const kind of ['git', 'ports', 'todo']) {
        await expect(cockpit.locator(`[data-grid-screen="${kind}"]`)).toBeVisible();
      }
      await expect(page.locator('[data-xterm]')).toHaveCount(0);

      // Bring the zsh screen to the center, by keyboard: it's the only xterm, with its input.
      const actor = `t:${terminalId}`;
      await cockpit.locator(`[data-screen-center="${actor}"]`).focus();
      await page.keyboard.press('Enter');
      const center = page.locator(`[data-grid-center="${actor}"]`);
      await expect(center).toBeVisible();
      await expect(cockpit).toHaveAttribute('data-centered', actor);
      await expect(page.locator('[data-xterm]')).toHaveCount(1);
      // No second WebGL context: the centered terminal draws with the DOM renderer.
      await expect(center.locator('[data-xterm]')).toHaveAttribute('data-renderer', 'dom');
      const input = center.locator('[data-command-line]');
      await expect(input).toBeFocused();
      const hello = `cockpit-${Math.random().toString(36).slice(2, 8)}`;
      await input.fill(`echo ${hello}`);
      await input.press('Enter');
      await expect(input).toHaveValue('');
      await expect(center.locator('.xterm-rows')).toContainText(hello);
      // It sits in the middle of the cockpit.
      const box = await center.boundingBox();
      const deck = await cockpit.boundingBox();
      if (!box || !deck) throw new Error('no boxes');
      expect(Math.abs(box.x + box.width / 2 - (deck.x + deck.width / 2))).toBeLessThan(4);

      // Esc once: the screen goes back to the arc, and focus with it.
      await page.keyboard.press('Escape');
      await expect(center).toHaveCount(0);
      await expect(page.locator('[data-xterm]')).toHaveCount(0);
      await expect(cockpit.locator(`[data-screen-actor="${actor}"]`)).toBeFocused();
      await expect(grid).toHaveAttribute('data-grid-entered', projectId);

      // Esc twice: the reverse dive, back on the network with the node focused.
      await page.keyboard.press('Escape');
      await expect(cockpit).toHaveCount(0);
      await expect(grid).not.toHaveAttribute('data-grid-entered', /.+/);
      await expect(stage).toHaveAttribute('data-grid-dive', 'out');
      await expect(node).toBeFocused();
      const back = await camera(page);
      expect(back.distance).toBeCloseTo(start.distance, 3);
      await expect(page.locator('.grid-labels')).toHaveCSS('visibility', 'visible');
    } finally {
      await stop();
    }
  });

  test('a screen clicked in the cockpit flies to the center', async ({ browser }) => {
    test.slow();
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit3');
      await expect(page.locator('[data-grid-3d][data-ready]')).toBeVisible();
      const node = page
        .locator('[data-grid-label] [data-grid-node]', {
          has: page.locator('[data-scene-actor^="s:"]'),
        })
        .first();
      const nodeId = await node.getAttribute('data-grid-node');
      // By id: the ring re-orders as attention changes.
      await page.locator(`[data-grid-node="${nodeId}"]`).focus();
      await page.keyboard.press('Enter');
      const cockpit = page.locator(`[data-grid-cockpit="${nodeId}"]`);
      await expect(cockpit).toBeVisible();
      // A click on the Claude screen's face centers it as the whole conversation.
      await cockpit.locator('[data-grid-screen="claude"] [data-screen-face]').first().click();
      const center = page.locator('[data-grid-center^="s:"]');
      await expect(center).toBeVisible();
      await expect(center.locator('[data-composer]')).toBeVisible();
      await center.locator('[data-center-close]').click();
      await expect(center).toHaveCount(0);
      await expect(cockpit).toBeVisible();
    } finally {
      await stop();
    }
  });

  test('without WebGL the Grid shows the 2D map', async ({ browser }) => {
    const { page, stop } = await openBoard(browser, undefined, disableWebgl);
    try {
      await page.keyboard.press('Alt+Digit3');
      await expect(page.locator('[data-grid]')).toHaveAttribute('data-grid-view', 'map');
      await expect(page.locator('[data-grid-map]')).toBeVisible();
      await expect(page.locator('[data-grid-map] [data-grid-pipe]').first()).toBeAttached();
      await expect(page.locator('canvas[data-grid-canvas]')).toHaveCount(0);
      await expect(page.locator('[data-grid-floor]')).toHaveAttribute('data-grid-floor', 'flat');
    } finally {
      await stop();
    }
  });

  test('at Reduced the Grid shows the 2D map', async ({ browser }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.evaluate(() => {
        localStorage.setItem('cboard.layout', 'grid');
        localStorage.setItem('cboard.motion', 'reduced');
      });
      await page.reload();
      await expect(page.locator('[data-grid-map]')).toBeVisible();
      await expect(page.locator('canvas[data-grid-canvas]')).toHaveCount(0);
    } finally {
      await stop();
    }
  });
});

test.describe('the Transit map', () => {
  test('shows the same amber and rose cues as Minimal, on its own ground', async ({ browser }) => {
    test.slow();
    const { page, stop } = await openBoard(browser);
    try {
      await expect(page.locator('[data-pod][data-tone="wait"]').first()).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(
          async () => {
            await page.keyboard.press('Alt+Digit1');
            await expect(layout(page)).toHaveAttribute('data-layout', 'minimal');
            await expect(page.locator('main [data-layout="transit"]')).toHaveCount(0);
            const minimal = await cues(page, false);
            const pods = await page.locator('[data-pod]').count();
            await page.keyboard.press('Alt+Digit4');
            await expect(layout(page)).toHaveAttribute('data-layout', 'transit');
            await expect(page.locator('main [data-layout="minimal"]')).toHaveCount(0);
            const count = (selector: string) => page.locator(selector).count();
            // One line per project.
            const lines = await count('[data-transit-line]');
            const wait = await count('[data-transit-line][data-tone="wait"]');
            const err = await count('[data-transit-line][data-tone="err"]');
            return lines === pods && minimal.wait === wait && minimal.err === err && wait > 0;
          },
          { timeout: 40_000, intervals: [500] },
        )
        .toBe(true);
      // The waiting session is a train with amber doors.
      await expect(
        page.locator('[data-transit-line] [data-scene-actor][data-train="wait"]').first(),
      ).toBeVisible();
      await expect(page.locator('[data-transit-ground]')).toHaveCount(1);
      await expect(page.locator('[data-ambient]')).toHaveCount(0);
      // The hour's history: stations on every line, "now" pinned at the right.
      await expect(page.locator('[data-transit-station]').first()).toBeVisible();
      const pinned = await page
        .locator('[data-transit-scroller]')
        .evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft);
      expect(pinned).toBeLessThanOrEqual(1);
    } finally {
      await stop();
    }
  });

  test('a station lands on its event, a train opens the inspector, a name opens the project', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit4');
      // A single finished turn: it opens its session.
      const station = page
        .locator('[data-transit-station][data-kind="turn"][data-count="1"][data-session]')
        .first();
      await expect(station).toBeVisible();
      const stationId = await station.getAttribute('data-transit-station');
      const sessionId = await station.getAttribute('data-session');
      const pinnedStation = page.locator(`[data-transit-station="${stationId}"]`);
      await pinnedStation.hover();
      await expect(page.locator(`[data-transit-tip="${stationId}"]`)).toContainText(
        'Turn finished',
      );
      await pinnedStation.click();
      await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/s/${sessionId}$`));
      await expect(page.locator('[data-focus]').first()).toBeVisible();

      await page.goBack();
      await expect(layout(page)).toHaveAttribute('data-layout', 'transit');
      const train = page.locator('[data-transit-line] [data-scene-actor]').first();
      const actorId = await train.getAttribute('data-scene-actor');
      await page.locator(`[data-scene-actor="${actorId}"]`).click();
      const inspector = page.locator('[data-actor-inspector]');
      await expect(inspector.locator('[data-actor]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);

      const name = page.locator('[data-transit-name]').first();
      const projectId = await name.getAttribute('data-transit-name');
      await name.click();
      await expect(page).toHaveURL(new RegExp(`#/p/${projectId}$`));
    } finally {
      await stop();
    }
  });

  test('keyboard: Tab to a line, arrows to a train, Enter inspects, Esc steps back', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit4');
      const name = page.locator('[data-transit-name]').first();
      await expect(name).toBeVisible();
      await name.focus();
      const line = page.locator('[data-transit-line]').first();
      await page.keyboard.press('ArrowRight');
      const first = line.locator('[data-transit-item]').first();
      await expect(first).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-actor-inspector] [data-actor]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-actor-inspector]')).toHaveCount(0);
      await expect(first).toBeFocused();
      // ← from the first item wraps to the oldest station.
      await page.keyboard.press('ArrowLeft');
      await expect(line.locator('[data-transit-item]').last()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(name).toBeFocused();
    } finally {
      await stop();
    }
  });

  test('on a touch phone: lines run top to bottom, 44 px targets, the inspector a sheet', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await page.evaluate(() => localStorage.setItem('cboard.layout', 'transit'));
      await page.reload();
      await expect(page.locator('[data-transit]')).toHaveAttribute('data-transit-axis', 'vertical');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      // "Now" on top: the first line's trains sit above its newest station.
      const line = page.locator('[data-transit-line]').first();
      const train = line.locator('[data-scene-actor]').first();
      const newest = line.locator('[data-transit-station]').first();
      const trainBox = await train.boundingBox();
      const stationBox = await newest.boundingBox();
      expect(trainBox?.y ?? 0).toBeLessThan(stationBox?.y ?? 0);
      for (const box of [trainBox, stationBox]) {
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      await train.tap();
      const sheet = page.locator('[data-actor-inspector][data-sheet]');
      await expect(sheet).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    } finally {
      await stop();
    }
  });

  test('at Reduced trains hold still and nothing loops', async ({ browser }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.evaluate(() => {
        localStorage.setItem('cboard.layout', 'transit');
        localStorage.setItem('cboard.motion', 'reduced');
      });
      await page.reload();
      await expect(page.locator('[data-transit-line]').first()).toBeVisible();
      await expect(page.locator('[data-train="glide"]').first()).toBeAttached({ timeout: 20_000 });
      const running = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (a) =>
                a instanceof CSSAnimation &&
                /^transit-(speed|doors)$/.test(a.animationName) &&
                a.playState === 'running',
            ).length,
      );
      expect(running).toBe(0);
    } finally {
      await stop();
    }
  });
});

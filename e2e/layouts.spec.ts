import {
  type Browser,
  type BrowserContextOptions,
  devices,
  type Locator,
  type Page,
} from '@playwright/test';
import { startBoard, startDemoBoard } from './board.js';
import { disableWebgl, expect, openRoute, signedInState, test, WEBGL } from './fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

const layout = (page: Page) => page.locator('main [data-layout]:not([aria-hidden], [data-focus])');

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
    storageState: signedInState(board.url, board.session),
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
      // A Claude session: a crowded room hides its idle shells first, so one may leave.
      const any = page.locator('[data-room] [data-scene-actor^="s:"]').first();
      await expect(any).toBeVisible();
      // Pinned by id: rooms reorder under a `.first()`.
      const actorId = await any.getAttribute('data-scene-actor');
      const character = page.locator(`[data-scene-actor="${actorId}"]`);
      const tag = character.locator('[data-office-tag]');
      await expect(tag).toHaveCSS('opacity', '0');
      // It can set off for another station between Playwright's aim and the move: point again
      // until it shows. Once pointed at, it holds still (no walk, never hidden) for the tag.
      // Each try is bounded: under the parallel suite's load one pointer move can take seconds.
      await expect(async () => {
        await character.hover({ timeout: 10_000 });
        await expect(tag).toHaveCSS('opacity', '1', { timeout: 2_000 });
      }).toPass({ timeout: 25_000 });
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

  test('names every character on the floor; plates and nameplates open the focus view', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit2');
      const session = page.locator('[data-room] [data-scene-actor^="s:"]').first();
      await expect(session).toBeVisible();
      const actorId = (await session.getAttribute('data-scene-actor')) as string;
      // Every drawn character has a name in the room without hovering; side desks share one.
      const named = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-room]')].every((room) => {
          const seated = room.querySelectorAll(
            '[data-office-at]:not([data-office-at="side-desk"])',
          );
          const lines = room.querySelectorAll(
            '[data-office-plate]:not([data-office-plate="side-desk"]) .office-plate-line',
          );
          return seated.length === lines.length;
        }),
      );
      expect(named).toBe(true);

      await page.locator(`[data-office-open="${actorId}"]`).click();
      await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/s/${actorId.slice(2)}$`));
      await page.goBack();
      await expect(layout(page)).toHaveAttribute('data-layout', 'office');

      const room = page.locator('[data-room]').first();
      const projectId = await room.getAttribute('data-room');
      await room.locator('a[data-kit-nameplate]').click();
      await expect(page).toHaveURL(new RegExp(`#/p/${projectId}$`));
    } finally {
      await stop();
    }
  });

  test('the legend maps each status token and stays folded per device', async ({ browser }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit2');
      const legend = page.locator('[data-status-legend]');
      await expect(legend).toHaveAttribute('data-status-legend', 'open');
      await expect(legend.locator('[data-legend-token]')).toHaveCount(6);
      await expect(legend.locator('[data-legend-token="quiet"] [data-status]')).toHaveCount(0);
      await legend.getByRole('button', { name: 'Legend' }).click();
      await expect(legend).toHaveAttribute('data-status-legend', 'closed');
      await page.reload();
      await expect(page.locator('[data-status-legend]')).toHaveAttribute(
        'data-status-legend',
        'closed',
      );
      await page.keyboard.press('Alt+Digit4');
      await expect(page.locator('[data-transit-line]').first()).toBeVisible();
      // The old layout's legend leaves with its cross-fade.
      await expect(page.locator('[data-status-legend]')).toHaveCount(1);
      await expect(page.locator('[data-status-legend]')).toHaveAttribute(
        'data-status-legend',
        'closed',
      );
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
      await page.evaluate(() => localStorage.setItem('yardmaster.layout', 'office'));
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
  await page.evaluate(() => localStorage.setItem('yardmaster.layout', 'office'));
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
        localStorage.setItem('yardmaster.layout', 'grid');
        localStorage.setItem('yardmaster.motion', 'reduced');
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

  test('on a touch phone: one trunk, 44 px satellites, the cockpit as a swipeable stack', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await page.evaluate(() => localStorage.setItem('yardmaster.layout', 'grid'));
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
      const cockpit = page.locator(`[data-grid-cockpit="${nodeId}"]`);
      const stack = cockpit.locator('[data-swipe-pager]');
      await expect(stack).toBeVisible();
      // A stack of full-width screens, one per swipe, inside the 16 px gutters.
      const scroll = await stack.evaluate((el) => ({
        width: el.scrollWidth,
        client: el.clientWidth,
        snap: getComputedStyle(el).scrollSnapType,
      }));
      expect(scroll.width).toBeGreaterThan(scroll.client);
      expect(scroll.snap).toContain('mandatory');
      const first = await cockpit.locator('[data-swipe-page="0"]').boundingBox();
      expect(first?.x).toBeCloseTo(16, 0);
      expect(first?.width).toBeCloseTo(390 - 32, 0);
      const position = cockpit.locator('[data-swipe-position]');
      await expect(position).toHaveAttribute('data-swipe-position', '0');
      // A swipe to the left brings the next screen in, whole.
      const from = { x: 300, y: (first?.y ?? 0) + 40 };
      const client = await page.context().newCDPSession(page);
      await client.send('Input.synthesizeScrollGesture', {
        x: from.x,
        y: from.y,
        xDistance: -220,
        yDistance: 0,
        gestureSourceType: 'touch',
        speed: 1200,
      });
      await expect(position).not.toHaveAttribute('data-swipe-position', '0');
      await restsOnAPage(cockpit);
      // The pager's buttons do the same for anyone who doesn't swipe.
      await cockpit.getByRole('button', { name: 'Previous screen', exact: true }).tap();
      await expect(position).toHaveAttribute('data-swipe-position', '0');
      await page.locator('[data-cockpit-back]').tap();
      await expect(grid).not.toHaveAttribute('data-grid-entered', /.+/);
      await expect(grid).toHaveAttribute('data-grid-view', 'trunk');
    } finally {
      await stop();
    }
  });
});

/** A swipe pager settles with one whole page inside the 16 px gutters, and says which. */
async function restsOnAPage(scope: Locator) {
  const pager = scope.locator('[data-swipe-pager]');
  await expect
    .poll(async () => {
      const at = await pager.evaluate((el) => el.scrollLeft);
      await scope.page().waitForTimeout(200);
      return at === (await pager.evaluate((el) => el.scrollLeft));
    })
    .toBe(true);
  const index = await scope.locator('[data-swipe-position]').getAttribute('data-swipe-position');
  const box = await scope.locator(`[data-swipe-page="${index}"]`).boundingBox();
  expect(box?.x).toBeCloseTo(16, 0);
}

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

test.describe(`the Grid 3D network ${WEBGL}`, () => {
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
      const projects = await page.locator('nav[aria-label="Projects"] a[href^="#/p/"]').count();
      expect(projects).toBeGreaterThan(0);
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
      // It settles in the middle of the cockpit (on the GPU the echo can beat its spring).
      await expect
        .poll(async () => {
          const box = await center.boundingBox();
          const deck = await cockpit.boundingBox();
          if (!box || !deck) throw new Error('no boxes');
          return Math.abs(box.x + box.width / 2 - (deck.x + deck.width / 2));
        })
        .toBeLessThan(4);

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
        localStorage.setItem('yardmaster.layout', 'grid');
        localStorage.setItem('yardmaster.motion', 'reduced');
      });
      await page.reload();
      await expect(page.locator('[data-grid-map]')).toBeVisible();
      await expect(page.locator('canvas[data-grid-canvas]')).toHaveCount(0);
    } finally {
      await stop();
    }
  });
});

test.describe('the Transit concourse', () => {
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
      await expect(page.locator('[data-transit]')).toHaveAttribute('data-transit-mode', 'wide');
      // The waiting session: a train with amber doors at its station, and on top of the board.
      await expect(
        page.locator('[data-transit-line] [data-scene-actor][data-train="wait"]').first(),
      ).toBeVisible();
      await expect(page.locator('[data-board-row]').first()).toHaveAttribute('data-tone', 'wait');
      await expect(page.locator('[data-board-row]').first()).toContainText('Due · needs you');
      await expect(page.locator('[data-transit-ground]')).toHaveCount(1);
      await expect(page.locator('[data-ambient]')).toHaveCount(0);
      // The hour's service log under the lines.
      await expect(page.locator('[data-transit-event]').first()).toBeVisible();
    } finally {
      await stop();
    }
  });

  test('a log bin lands on its event, a station or board row opens the inspector, a name the project', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit4');
      // A single finished turn: it opens its session.
      const bin = page
        .locator('[data-transit-event][data-kind="turn"][data-count="1"][data-session]')
        .first();
      await expect(bin).toBeVisible({ timeout: 20_000 });
      const binId = await bin.getAttribute('data-transit-event');
      const sessionId = await bin.getAttribute('data-session');
      const line = await bin
        .locator('xpath=ancestor::*[@data-transit-line][1]')
        .getAttribute('data-transit-line');
      const pinned = page.locator(`[data-transit-line="${line}"] [data-transit-event="${binId}"]`);
      await pinned.hover();
      await expect(page.locator(`[data-transit-tip="${binId}"]`)).toContainText('Turn finished');
      await pinned.click();
      await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/s/${sessionId}$`));
      await expect(page.locator('[data-focus]').first()).toBeVisible();

      await page.goBack();
      await expect(layout(page)).toHaveAttribute('data-layout', 'transit');
      const station = page.locator('[data-transit-line] [data-transit-station]').first();
      const actorId = await station.getAttribute('data-transit-station');
      await page.locator(`[data-transit-station="${actorId}"]`).click();
      const inspector = page.locator('[data-actor-inspector]');
      await expect(inspector.locator('[data-actor]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);

      // Pointing at a board row lights its station on the map; a click inspects it. Rows re-sort
      // until the pointer is on the board (then they hold), so the row is pinned by its actor.
      const rowActor = await page
        .locator('[data-board-row]')
        .first()
        .getAttribute('data-board-row');
      const row = page.locator(`[data-board-row="${rowActor}"]`);
      await row.hover();
      await expect(page.locator(`[data-transit-station="${rowActor}"]`)).toHaveAttribute(
        'data-lit',
        '',
      );
      await row.click();
      await expect(page.locator(`[data-actor-inspector="${rowActor}"]`)).toBeVisible();
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

  test('a station name opens the focus view, with a token mark on what needs you', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit4');
      await expect(page.locator('[data-transit-open]').first()).toBeVisible();
      await expect(
        page.locator('[data-transit-open][data-tone="wait"] [data-mark="wait"]').first(),
      ).toBeVisible({
        timeout: 30_000,
      });
      const session = page.locator('[data-transit-open^="s:"]').first();
      const actorId = (await session.getAttribute('data-transit-open')) as string;
      await page.locator(`[data-transit-open="${actorId}"]`).click();
      await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/s/${actorId.slice(2)}$`));
    } finally {
      await stop();
    }
  });

  test('keyboard: Tab to a line, arrows to a station, Enter inspects, Esc steps back', async ({
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
      await expect(first).toHaveAttribute('data-transit-station', /.+/);
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-actor-inspector] [data-actor]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-actor-inspector]')).toHaveCount(0);
      await expect(first).toBeFocused();
      // ← from the first item wraps to the log's oldest bin.
      await page.keyboard.press('ArrowLeft');
      await expect(line.locator('[data-transit-item]').last()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(name).toBeFocused();

      // The board is one Tab stop; the arrows move between its rows.
      // The live board can re-sort between key presses, so compare positions, not rows.
      const rows = page.locator('[data-board-row]');
      const focusedIndex = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-board-row]')].indexOf(
            document.activeElement as Element,
          ),
        );
      await rows.first().focus();
      await page.keyboard.press('ArrowDown');
      await expect.poll(focusedIndex).toBeGreaterThan(0);
      await page.keyboard.press('Home');
      await expect.poll(focusedIndex).toBe(0);
    } finally {
      await stop();
    }
  });

  test('on a touch phone: the board, then each line as a station list, 44 px targets', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await page.evaluate(() => localStorage.setItem('yardmaster.layout', 'transit'));
      await page.reload();
      await expect(page.locator('[data-transit]')).toHaveAttribute('data-transit-mode', 'phone');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      // The board first, at most five departures.
      const board = page.locator('[data-transit-board]');
      const firstLine = page.locator('[data-transit-line]').first();
      const boardBox = await board.boundingBox();
      const lineBox = await firstLine.boundingBox();
      expect(boardBox?.y ?? 0).toBeLessThan(lineBox?.y ?? 0);
      expect(await board.locator('[data-board-row]').count()).toBeLessThanOrEqual(5);
      // Every line is there, one after the other.
      expect(await page.locator('[data-transit-line]').count()).toBe(6);
      // Stations and log bins are 44 px targets.
      const station = firstLine.locator('[data-transit-station]').first();
      const bin = firstLine.locator('[data-transit-event]').first();
      await station.scrollIntoViewIfNeeded();
      await expect(bin).toBeVisible({ timeout: 20_000 });
      for (const target of [station, bin]) {
        const box = await target.boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      await station.tap();
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
        localStorage.setItem('yardmaster.layout', 'transit');
        localStorage.setItem('yardmaster.motion', 'reduced');
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

test.describe('the Retro console', () => {
  test('shows the same amber and rose cues as Minimal, on its own screen', async ({ browser }) => {
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
            await expect(page.locator('main [data-layout="retro"]')).toHaveCount(0);
            const minimal = await cues(page, false);
            const pods = await page.locator('[data-pod]').count();
            await page.keyboard.press('Alt+Digit5');
            await expect(layout(page)).toHaveAttribute('data-layout', 'retro');
            await expect(page.locator('main [data-layout="minimal"]')).toHaveCount(0);
            const count = (selector: string) => page.locator(selector).count();
            const frames = await count('[data-retro-frame]');
            const wait = await count('[data-retro-frame][data-tone="wait"]');
            const err = await count('[data-retro-frame][data-tone="err"]');
            return frames === pods && minimal.wait === wait && minimal.err === err && wait > 0;
          },
          { timeout: 40_000, intervals: [500] },
        )
        .toBe(true);
      // Status in words as well as color: the waiting session's tag.
      const waiting = page.locator('[data-retro-frame] [data-scene-actor][data-tone="wait"]');
      await expect(waiting.first()).toContainText('[WAIT]');
      await expect(page.locator('[data-retro-ground]')).toHaveCount(1);
      await expect(page.locator('[data-ambient]')).toHaveCount(0);
      // Something works: its cursor blinks.
      await expect(page.locator('[data-retro] .retro-cursor[data-blink]').first()).toBeAttached();
    } finally {
      await stop();
    }
  });

  test('number keys jump to a project and an actor, Enter inspects, Esc steps back', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await page.keyboard.press('Alt+Digit5');
      const frames = page.locator('[data-retro-frame]');
      await expect(frames.first()).toBeVisible();
      await expect(frames.nth(1).locator('[data-retro-name]')).toContainText('[2]');

      await page.keyboard.press('2');
      const second = frames.nth(1);
      const name = second.locator('[data-retro-name]');
      await expect(name).toBeFocused();
      await page.keyboard.press('1');
      const actor = second.locator('[data-retro-key="1"]');
      await expect(actor).toBeFocused();
      await page.keyboard.press('Enter');
      const inspector = page.locator('[data-actor-inspector]');
      await expect(inspector.locator('[data-actor]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(inspector).toHaveCount(0);
      await expect(actor).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(name).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(actor).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(name).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-retro]')).toBeFocused();

      // Back on the board, a number picks a project again; Enter opens it.
      await page.keyboard.press('1');
      const first = frames.first().locator('[data-retro-name]');
      await expect(first).toBeFocused();
      const projectId = await frames.first().getAttribute('data-retro-frame');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`#/p/${projectId}$`));
    } finally {
      await stop();
    }
  });

  test('fits 20 projects at 1440 × 900 on one character grid, and "12" jumps to the 12th', async ({
    browser,
  }) => {
    test.slow();
    const board = await startBoard({ demo: true, stress: true, projects: 20 });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: board.url,
      storageState: signedInState(board.url, board.session),
    });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'retro'));
      await openRoute(page, '/');
      const frames = page.locator('[data-retro-frame]');
      await expect(frames).toHaveCount(20);
      await expect(page.locator('[data-retro]')).toHaveAttribute('data-retro-cols', '4');

      const grid = await page.evaluate(() => {
        const console = document.querySelector<HTMLElement>('[data-retro]');
        const probe = console?.querySelector<HTMLElement>('.retro-probe');
        const ch = (probe?.getBoundingClientRect().width ?? 0) / 100;
        const main = document.querySelector('main')?.getBoundingClientRect();
        const boxes = [...document.querySelectorAll<HTMLElement>('[data-retro-frame]')].map(
          (frame) => {
            const box = frame.getBoundingClientRect();
            const widths = [...frame.querySelectorAll<HTMLElement>('.retro-line, .retro-row')].map(
              (line) => line.getBoundingClientRect().width,
            );
            return { x: box.x, y: box.y, bottom: box.bottom, right: box.right, widths };
          },
        );
        return { ch, mainBottom: main?.bottom ?? 0, mainRight: main?.right ?? 0, boxes };
      });
      expect(grid.ch).toBeGreaterThan(0);
      const xs = new Set(grid.boxes.map((b) => Math.round(b.x)));
      const ys = new Set(grid.boxes.map((b) => Math.round(b.y)));
      expect(xs.size).toBe(4);
      expect(ys.size).toBe(5);
      for (const box of grid.boxes) {
        // Every frame is on screen, and every line of it is the frame's width to the character.
        expect(box.bottom).toBeLessThanOrEqual(grid.mainBottom);
        expect(box.right).toBeLessThanOrEqual(grid.mainRight);
        const width = box.right - box.x;
        for (const line of box.widths) expect(Math.abs(line - width)).toBeLessThan(0.5);
        expect(Math.abs(width / grid.ch - Math.round(width / grid.ch))).toBeLessThan(0.05);
      }

      await page.locator('[data-retro]').focus();
      await page.keyboard.press('1');
      await expect(frames.first().locator('[data-retro-name]')).toBeFocused();
      await page.keyboard.press('2');
      await expect(frames.nth(11).locator('[data-retro-name]')).toBeFocused();
    } finally {
      await context.close();
      await board.stop();
    }
  });

  test('on a touch phone: one frame per row, 44 px targets, the inspector a sheet', async ({
    browser,
  }) => {
    const { page, stop } = await openBoard(browser, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await page.evaluate(() => localStorage.setItem('yardmaster.layout', 'retro'));
      await page.reload();
      const console = page.locator('[data-retro]');
      await expect(console).toHaveAttribute('data-stacked', '');
      await expect(console).toHaveAttribute('data-retro-cols', '1');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const chars = await console.evaluate((el) => {
        const probe = el.querySelector('.retro-probe')?.getBoundingClientRect().width ?? 0;
        const frame = el.querySelector('[data-retro-frame]')?.getBoundingClientRect().width ?? 0;
        return Math.round(frame / (probe / 100));
      });
      expect(chars).toBeGreaterThanOrEqual(40);

      const frame = page.locator('[data-retro-frame]').first();
      const name = frame.locator('[data-retro-name]');
      const actor = frame.locator('[data-scene-actor]').first();
      for (const target of [name, actor]) {
        const box = await target.boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      await actor.tap();
      const sheet = page.locator('[data-actor-inspector][data-sheet]');
      await expect(sheet).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    } finally {
      await stop();
    }
  });

  test('the amber phosphor from Settings, and at Reduced nothing blinks', async ({ browser }) => {
    const { page, stop } = await openBoard(browser);
    try {
      await openRoute(page, '/settings');
      await page
        .locator('[data-setting="phosphor"]')
        .getByRole('button', { name: 'Amber' })
        .click();
      await page.evaluate(() => {
        localStorage.setItem('yardmaster.layout', 'retro');
        localStorage.setItem('yardmaster.motion', 'reduced');
      });
      await openRoute(page, '/');
      await page.reload();
      const console = page.locator('[data-retro]');
      await expect(console).toHaveAttribute('data-phosphor', 'amber');
      await expect(page.locator('[data-retro-ground]')).toHaveAttribute('data-phosphor', 'amber');
      await expect(page.locator('.retro-cursor[data-blink]').first()).toBeAttached({
        timeout: 20_000,
      });
      const running = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (a) =>
                a instanceof CSSAnimation &&
                a.animationName === 'retro-blink' &&
                a.playState === 'running',
            ).length,
      );
      expect(running).toBe(0);
    } finally {
      await stop();
    }
  });
});

// The phone pass. Every layout and enter view on an iPhone profile (touch, 390 px wide),
// in Chromium: every tap target is at least 44 px, an actor opens the inspector as a bottom
// sheet, and the back gesture closes the sheet and leaves the enter view, like Esc.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];

/** Visible pressable things in the layout smaller than 44 × 44 px. */
function smallTargets(page: Page, scope: string) {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope);
    if (!root) return ['no layout'];
    const small: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], [role="link"], [role="tab"], [tabindex="0"]',
    )) {
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      if (Number(style.opacity) === 0 || style.pointerEvents === 'none') continue;
      if (box.bottom < 0 || box.top > innerHeight) continue;
      // Half a px of slack for subpixel layout.
      if (box.width < 43.5 || box.height < 43.5) {
        const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
        small.push(
          `${el.tagName.toLowerCase()} "${name}" ${box.width.toFixed(0)}×${box.height.toFixed(0)}`,
        );
      }
    }
    return small;
  }, scope);
}

const PHONE_LAYOUTS = {
  office: { item: '[data-room]', enter: '[data-office]', entered: 'data-office-entered' },
  grid: { item: '[data-grid-node]', enter: '[data-grid]', entered: 'data-grid-entered' },
  transit: { item: '[data-transit-line]', enter: null, entered: null },
  retro: { item: '[data-retro-frame]', enter: null, entered: null },
} as const;

test.describe('the phone pass', () => {
  test.use({ ...iPhone });

  for (const [name, spec] of Object.entries(PHONE_LAYOUTS)) {
    test(`${name}: 44 px targets, the inspector a sheet, Back closes it`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), name);
      await openRoute(page, '/');
      const scope = 'main [data-layout]:not([aria-hidden])';
      await expect(page.locator(spec.item).first()).toBeVisible();
      await page.waitForTimeout(600);
      expect(await smallTargets(page, scope)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const actor = layout(page).locator('[data-scene-actor]').first();
      await actor.scrollIntoViewIfNeeded();
      await actor.tap();
      const sheet = page.locator('[data-actor-inspector][data-sheet]');
      await expect(sheet).toBeVisible();
      await page.goBack();
      await expect(sheet).toHaveCount(0);
      await expect(page).toHaveURL(/#\/$/);
      await expect(page.locator(spec.item).first()).toBeVisible();
      // Closing it another way doesn't leave an entry behind for Back to land on.
      await actor.tap();
      await expect(sheet).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => history.state?.yardmasterInspector))
        .toBeUndefined();
    });

    if (!spec.enter || !spec.entered) continue;
    const { enter, entered } = spec;
    test(`${name}: the enter view on a phone, and Back leaves it`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), name);
      await openRoute(page, '/');
      const item = page.locator(spec.item).first();
      await expect(item).toBeVisible();
      await item.tap({ position: { x: 60, y: 6 } });
      const stage = page.locator(enter);
      await expect(stage).toHaveAttribute(entered, /.+/);
      await page.waitForTimeout(900);
      expect(await smallTargets(page, scope(name))).toEqual([]);

      // An actor in the enter view opens the sheet; Back closes the sheet, then the view.
      const actor = page.locator(`${ENTERED_ACTORS[name as 'office' | 'grid']}`).first();
      await actor.tap();
      const sheet = page.locator('[data-actor-inspector][data-sheet]');
      await expect(sheet).toBeVisible();
      await page.goBack();
      await expect(sheet).toHaveCount(0);
      await expect(stage).toHaveAttribute(entered, /.+/);
      await page.goBack();
      await expect(stage).not.toHaveAttribute(entered, /.+/);
      await expect(page).toHaveURL(/#\/$/);
    });
  }
});

const scope = (name: string) =>
  name === 'grid' ? '[data-grid-cockpit]' : 'main [data-layout]:not([aria-hidden])';
const ENTERED_ACTORS = {
  office: '[data-office-room-panel] [data-room-actor]',
  grid: '[data-grid-cockpit] [data-scene-actor]',
} as const;

// DESIGN.md §10.7 on the worst-case board (`?worst=1`): long names, a fleet of 231
// actors, an empty project and one with nothing but errors.
test.describe('the layouts with worst-case data', () => {
  const openWorst = async (page: Page, name: string) => {
    await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), name);
    await page.goto('/?worst=1#/');
  };

  test('Office: nameplates truncate with a tooltip, +N past 8, every cue', async ({ page }) => {
    await openWorst(page, 'office');
    const rooms = page.locator('[data-room]');
    await expect(rooms).toHaveCount(7);
    const fleet = rooms.filter({ hasText: 'fleet-load-test' });
    // 104 sessions and 127 terminals: at most 8 drawn, the rest in the door's "+N".
    await expect(fleet.locator('[data-room-more]')).toBeVisible();
    const shown = await fleet.locator('[data-scene-actor]').count();
    expect(shown).toBeLessThanOrEqual(8);
    await expect(fleet.locator('[data-room-more]')).toHaveAttribute(
      'data-room-more',
      String(231 - shown),
    );
    const plate = page.locator('[data-room] [title^="northwind-industries"]').first();
    const clipped = await plate.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(true);
    // Only errors: the room reads rose.
    await expect(rooms.filter({ hasText: 'nightly-etl' })).toHaveAttribute('data-tone', 'err');
  });

  for (const name of ['grid', 'transit', 'retro'] as const) {
    test(`${name}: the long names stay inside their columns`, async ({ page }) => {
      if (name === 'grid') await disableWebgl(page);
      await openWorst(page, name);
      const item = {
        grid: '[data-grid-node]',
        transit: '[data-transit-line]',
        retro: '[data-retro-frame]',
      }[name];
      await expect(page.locator(item)).toHaveCount(7);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(page.locator(item).filter({ hasText: 'nightly-etl' })).toHaveAttribute(
        'data-tone',
        'err',
      );
      if (name === 'grid') {
        // The 2D map's node cards never overlap, whatever their names.
        const cards = await page
          .locator('[data-grid-map] [data-grid-node]')
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
        for (const [i, a] of cards.entries()) {
          for (const b of cards.slice(i + 1)) {
            const apart =
              a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
            expect(apart).toBe(true);
          }
        }
      }
    });
  }
});

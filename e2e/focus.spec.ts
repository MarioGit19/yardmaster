import type { Page } from '@playwright/test';
import {
  expect,
  FOCUS_LAYOUTS,
  type FocusLayout,
  firstProjectRoute,
  openRoute,
  test,
} from './fixtures.js';

/**
 * Each layout's way into a project from its overview: the item, its id, a step in (Office's room
 * view, Grid's cockpit) and the link to click.
 */
const OPENERS: Record<
  FocusLayout,
  {
    item: string;
    id: string;
    enter?: (page: Page, id: string) => Promise<void>;
    link: (id: string) => string;
  }
> = {
  minimal: { item: '[data-pod]', id: 'data-pod', link: (id) => `[data-pod="${id}"] header a` },
  office: {
    item: '[data-room]',
    id: 'data-room',
    // Enter on the room zooms into its room view; the view's Open workspace opens the workspace.
    enter: async (page, id) => {
      await page.locator(`[data-room="${id}"]`).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(`[data-office-room-panel="${id}"]`)).toBeVisible();
    },
    link: (id) => `[data-office-room-panel="${id}"] [data-room-open]`,
  },
  grid: {
    item: '[data-grid-node]',
    id: 'data-grid-node',
    // Enter on the node dives into its cockpit; the cockpit's Open workspace opens the view.
    enter: async (page, id) => {
      await page.locator(`[data-grid-node="${id}"]`).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(`[data-grid-cockpit="${id}"]`)).toBeVisible();
    },
    link: (id) => `[data-grid-cockpit="${id}"] [data-cockpit-open]`,
  },
  transit: {
    item: '[data-transit-line]',
    id: 'data-transit-line',
    link: (id) => `[data-transit-name="${id}"]`,
  },
  retro: {
    item: '[data-retro-frame]',
    id: 'data-retro-frame',
    link: (id) => `[data-retro-name="${id}"]`,
  },
};

/** Opens the first project from the layout's overview by its name link, as a user would. */
async function openFirstProject(page: Page, layout: FocusLayout) {
  const opener = OPENERS[layout];
  await openRoute(page, '/');
  const first = page.locator(opener.item).first();
  await expect(first).toBeVisible();
  const id = await first.getAttribute(opener.id);
  if (!id) throw new Error('project without an id');
  await opener.enter?.(page, id);
  await page.locator(opener.link(id)).click();
  const card = page.locator(`[data-focus="${id}"]`);
  await expect(card).toBeVisible();
  // The workspace wears the layout's skin (DESIGN.md §10.8).
  await expect(card).toHaveAttribute('data-layout', layout);
  // Measure the view, not the morph: wait until the card and its columns have settled.
  await expect
    .poll(() =>
      card.evaluate((el) =>
        [el, ...el.querySelectorAll('section')].every(
          (node) => getComputedStyle(node).transform === 'none',
        ),
      ),
    )
    .toBe(true);
  return { id, card };
}

/**
 * Notes a skin's entry from the page as it plays, with its still copy and the card's opacity. The
 * entry is short and a loaded runner may poll after it has gone. Call before the click that opens
 * the workspace; gives up after 5 s without one.
 */
function watchEntry(page: Page, entryAttr: string, ghostAttr: string) {
  return page.evaluate(
    ({ entryAttr, ghostAttr }) =>
      new Promise<{ entry: boolean; ghost: boolean; opacity: string }>((resolve) => {
        const observer = new MutationObserver(() => {
          const entry = document.querySelector(`[${entryAttr}]`);
          if (!entry) return;
          observer.disconnect();
          const card = entry.closest<HTMLElement>('[data-focus]');
          resolve({
            entry: true,
            ghost: entry.querySelector(`[${ghostAttr}]`) !== null,
            opacity: card ? getComputedStyle(card).opacity : '',
          });
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => resolve({ entry: false, ghost: false, opacity: '' }), 5_000);
      }),
    { entryAttr, ghostAttr },
  );
}

/**
 * Samples an element's box every frame for `ms` from the moment it changes (or appears), to
 * check a morph is continuous. Gives up after 10 s without a change.
 */
function sampleBoxes(page: Page, selector: string, ms: number) {
  return page.evaluate(
    ({ selector, ms }) =>
      new Promise<{ w: number; h: number; x: number }[]>((resolve) => {
        const boxes: { w: number; h: number; x: number }[] = [];
        const read = () => {
          const r = document.querySelector(selector)?.getBoundingClientRect();
          return r ? { w: r.width, h: r.height, x: r.left } : null;
        };
        const first = read();
        const begun = performance.now();
        let start: number | null = null;
        const tick = () => {
          const box = read();
          const now = performance.now();
          if (start === null && box && (!first || box.w !== first.w || box.x !== first.x)) {
            start = now;
          }
          if (start !== null && box) boxes.push(box);
          if (start === null ? now - begun < 10_000 : now - start < ms) {
            requestAnimationFrame(tick);
          } else resolve(boxes);
        };
        tick();
      }),
    { selector, ms },
  );
}

/**
 * A context on a browser with the GPU, for one test. The headless shell draws the blurred overview
 * on the CPU, and one composite can hold back rAF for 300+ ms, which is what a frame count measures.
 */
const onGpu = test.extend({
  context: async ({ playwright, baseURL, storageState, viewport, colorScheme }, use) => {
    const browser = await playwright.chromium.launch({ channel: 'chromium' });
    await use(await browser.newContext({ baseURL, storageState, viewport, colorScheme }));
    await browser.close();
  },
});

// Pods morph into their focus view; other layouts enter through their skin (below).
test.describe('minimal at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  onGpu('the pod morphs into the focus view and back', async ({ page }) => {
    await openRoute(page, '/');
    const first = page.locator('[data-pod]').first();
    await expect(first).toBeVisible();
    // By id: a project starting to wait can reorder the grid while the test runs.
    const id = await first.getAttribute('data-pod');
    const pod = page.locator(`[data-pod="${id}"]`);
    const podBox = await pod.boundingBox();
    if (!id || !podBox) throw new Error('no pod');

    const sampling = sampleBoxes(page, `[data-focus="${id}"]`, 700);
    await pod.locator('header a').click();
    const frames = await sampling;
    // The card starts near the pod's size and grows over several frames, not in one jump.
    const sizes = frames.map((f) => Math.round(f.w));
    const distinct = new Set(sizes).size;
    expect(distinct).toBeGreaterThan(4);
    expect(sizes[0]).toBeLessThan(podBox.width * 1.6);
    const final = await page.locator(`[data-focus="${id}"]`).boundingBox();
    expect(final?.width ?? 0).toBeGreaterThan(podBox.width * 2);

    // The overview stays behind it, dimmed, blurred and inert.
    const backdrop = page.locator('main > [data-screen] > div').first();
    await expect(backdrop).toHaveAttribute('inert', '');
    await expect
      .poll(() => backdrop.evaluate((el) => getComputedStyle(el).filter))
      .toContain('blur');

    // Esc morphs it back: the pod returns to its place and gets keyboard focus.
    const back = sampleBoxes(page, `[data-pod="${id}"]`, 700);
    await page.keyboard.press('Escape');
    const returning = await back;
    expect(new Set(returning.map((f) => Math.round(f.w))).size).toBeGreaterThan(4);
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator(`[data-focus="${id}"]`)).toHaveCount(0);
    await expect(backdrop).not.toHaveAttribute('inert', '');
    await expect(pod.locator('header a')).toBeFocused();
    await expect
      .poll(async () => Math.round((await pod.boundingBox())?.width ?? 0))
      .toBe(Math.round(podBox.width));
  });
});

for (const layout of FOCUS_LAYOUTS) {
  test.describe(`${layout} workspace`, () => {
    test.use({ layout });

    test.describe('at 1440', () => {
      test.use({ viewport: { width: 1440, height: 900 } });

      test('a released handle springs to a snap width and is remembered', async ({ page }) => {
        const { card } = await openFirstProject(page, layout);
        const handle = card.locator('[role="separator"][data-resize="left"]');
        // A body under 1280px wide starts with the slimmer left column.
        await expect(handle).toHaveAttribute('aria-valuenow', '240');
        const box = await handle.boundingBox();
        if (!box) throw new Error('no handle');
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width / 2, y);
        await page.mouse.down();
        // 240 + 92 = 332: within the snap radius of 340.
        await page.mouse.move(box.x + box.width / 2 + 50, y, { steps: 4 });
        await page.mouse.move(box.x + box.width / 2 + 92, y, { steps: 4 });
        await expect(handle).toHaveAttribute('aria-valuenow', '332');
        await page.mouse.up();
        await expect(handle).toHaveAttribute('aria-valuenow', '340');
        const left = card.locator('section').first();
        await expect.poll(async () => Math.round((await left.boundingBox())?.width ?? 0)).toBe(340);

        await page.reload();
        await expect(card.locator('[role="separator"][data-resize="left"]')).toHaveAttribute(
          'aria-valuenow',
          '340',
        );
      });

      test('terminals refit once when a resize lands, not every frame', async ({ page }) => {
        const { card } = await openFirstProject(page, layout);
        const screen = card.locator('[data-xterm] .xterm-screen').first();
        await expect(screen).toBeVisible();
        const handle = card.locator('[role="separator"][data-resize="right"]');
        const now = Number(await handle.getAttribute('aria-valuenow'));
        const max = Number(await handle.getAttribute('aria-valuemax'));
        // Release 16px short of a wider snap, so the handle springs the rest of the way.
        const snap = [340, 420, 520, 620].find((s) => s >= now + 60 && s <= max);
        if (!snap) throw new Error(`no snap width above ${now}`);
        const box = await handle.boundingBox();
        if (!box) throw new Error('no handle');

        // Every frame: the terminal's drawn width, and whether the grid is mid-resize.
        await page.evaluate(() => {
          const w = window as unknown as { __frames: { w: number; resizing: boolean }[] };
          w.__frames = [];
          const tick = () => {
            const el = document.querySelector('[data-focus] [data-xterm] .xterm-screen');
            const resizing = !!document.querySelector('[data-focus] [data-resizing]');
            if (el) w.__frames.push({ w: Math.round(el.getBoundingClientRect().width), resizing });
            if (w.__frames.length < 2000) requestAnimationFrame(tick);
          };
          tick();
        });
        const before = Math.round((await screen.boundingBox())?.width ?? 0);
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - (snap - 16 - now) / 2, y, { steps: 5 });
        await page.mouse.move(x - (snap - 16 - now), y, { steps: 5 });
        // Mid-drag the ARIA value follows the pointer, but the terminal keeps its size.
        await expect(handle).toHaveAttribute('aria-valuenow', String(snap - 16));
        expect(Math.round((await screen.boundingBox())?.width ?? 0)).toBe(before);
        await page.mouse.up();
        await expect(handle).toHaveAttribute('aria-valuenow', String(snap));
        await expect(card.locator('[data-resizing]')).toHaveCount(0);
        await expect
          .poll(async () => Math.round((await screen.boundingBox())?.width ?? 0))
          .toBeGreaterThan(before);
        const after = Math.round((await screen.boundingBox())?.width ?? 0);

        // The fit runs in a frame after the sampler's read: let the sampler see the new width.
        const sampled = () =>
          page.evaluate(
            () => (window as unknown as { __frames: { w: number; resizing: boolean }[] }).__frames,
          );
        await expect.poll(async () => (await sampled()).at(-1)?.w).toBe(after);
        const frames = await sampled();
        const during = frames.filter((f) => f.resizing);
        expect(during.length).toBeGreaterThan(5);
        expect(new Set(during.map((f) => f.w))).toEqual(new Set([before]));
        // One fit after it lands: the terminal jumps straight from its old width to its new one.
        const widths = frames.map((f) => f.w).filter((w, i, all) => i === 0 || w !== all[i - 1]);
        expect(widths).toHaveLength(2);
      });
    });

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ] as const) {
      test(`three columns side by side at ${viewport.width}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const { card } = await openFirstProject(page, layout);
        const columns = card.locator(':scope > div > div > section');
        await expect(columns).toHaveCount(3);
        await expect(card.locator('[role="separator"]')).toHaveCount(2);
        const boxes = await columns.evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, width: r.width };
          }),
        );
        const [sessions, claude, terminals] = boxes;
        if (!sessions || !claude || !terminals) throw new Error('missing column');
        expect(sessions.right).toBeLessThanOrEqual(claude.left);
        expect(claude.right).toBeLessThanOrEqual(terminals.left);
        expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(1);
        // Nobody resized them: the defaults follow the body width (`defaultSizes`), and the Claude
        // panel keeps the largest share.
        const body = await columns
          .first()
          .evaluate((el) => (el.parentElement as HTMLElement).clientWidth);
        expect(Math.round(sessions.width)).toBe(body < 1280 ? 240 : 280);
        expect(Math.round(terminals.width)).toBe(
          Math.min(520, Math.max(300, Math.round(body * 0.3))),
        );
        expect(claude.width).toBeGreaterThan(terminals.width);
        // The card fills the main area inside the page gutters, without page scroll.
        const cardBox = await card.boundingBox();
        expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
      });
    }

    test('stacked tabs at 900', async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 900 });
      const { card } = await openFirstProject(page, layout);
      // The view's own tabs; the terminal stack inside has tabs of its own.
      const panels = card.getByRole('tablist', { name: 'Focus view panels' });
      await expect(panels.getByRole('tab')).toHaveText(['Sessions', 'Claude', 'Terminals']);
      await expect(panels.getByRole('tab', { name: 'Claude' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(card.locator('[role="separator"]')).toHaveCount(0);
      await panels.getByRole('tab', { name: 'Terminals' }).click();
      await expect(card.locator('[id^="focus-panel-"]:visible')).toHaveCount(1);
      await expect(card.locator('#focus-panel-terminals')).toContainText('Terminals');
      await expect(card.locator('#focus-panel-terminals [data-terminal-stack]')).toBeVisible();
    });

    test('a project hub at 390', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const { card } = await openFirstProject(page, layout);
      // Phones get the full-bleed workspace (DESIGN.md §11): edge to edge, a hub instead of tabs.
      await expect(card.locator('[data-hub]')).toBeVisible();
      await expect(card.getByRole('tablist', { name: 'Focus view panels' })).toHaveCount(0);
      const box = await card.boundingBox();
      expect(Math.round(box?.x ?? -1)).toBe(0);
      expect(Math.round(box?.width ?? 0)).toBe(390);
    });

    test('at Reduced the focus view swaps without movement', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
      const opener = OPENERS[layout];
      await openRoute(page, '/');
      const first = page.locator(opener.item).first();
      await expect(first).toBeVisible();
      const id = await first.getAttribute(opener.id);
      if (!id) throw new Error('project without an id');
      const sampling = sampleBoxes(page, `[data-focus="${id}"]`, 400);
      await opener.enter?.(page, id);
      await page.locator(opener.link(id)).click();
      const widths = (await sampling).map((f) => Math.round(f.w));
      expect(widths.length).toBeGreaterThan(0);
      expect(new Set(widths).size).toBe(1);
    });
  });
}

// Retro's workspace skin (DESIGN.md §10.8): the frame's text opens into the workspace, the number
// shortcuts carry over, and Esc returns to the same frame.
test.describe('retro at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, layout: 'retro' });

  test('the frame opens into the workspace line by line, and Esc returns to it', async ({
    page,
  }) => {
    await openRoute(page, '/');
    const frame = page.locator('[data-retro-frame]').first();
    await expect(frame).toBeVisible();
    const id = await frame.getAttribute('data-retro-frame');
    if (!id) throw new Error('frame without an id');
    const name = page.locator(`[data-retro-name="${id}"]`);
    await name.focus();
    await page.keyboard.press('Enter');
    const card = page.locator(`[data-focus="${id}"]`);
    // The card is there at once: the reveal lifts the screen off it band by band, then goes.
    await expect(card.locator('[data-retro-entry]')).toBeAttached();
    expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(card.locator('[data-retro-entry]')).toHaveCount(0);
    await expect(card).toHaveAttribute('data-layout', 'retro');
    await expect(card.locator('[data-retro-band]')).toBeVisible();
    for (const panel of ['Sessions', 'Claude', 'Terminals']) {
      await expect(card.locator(`[data-retro-panel="${panel}"]`)).toBeVisible();
    }
    // Text mode: Geist Mono, square corners, `[ ESC ]` back.
    expect(await card.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Geist Mono');
    await expect(card.getByRole('link', { name: 'Back to the overview' })).toHaveText('ESC');

    // Number shortcuts: session rows first, then terminal tabs.
    const rows = card.locator('a[data-session]');
    await expect(rows.first()).toBeVisible();
    const sessions = await rows.count();
    const href = await rows.nth(sessions > 1 ? 1 : 0).getAttribute('href');
    await page.keyboard.press(sessions > 1 ? '2' : '1');
    await expect(page).toHaveURL((url) => url.hash === href);
    const tab = card.locator('[role="tab"][data-tab]').last();
    const tabs = await card.locator('[role="tab"][data-tab]').count();
    if (sessions + tabs <= 9) {
      await page.keyboard.press(String(sessions + tabs));
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(name).toBeFocused();
  });

  test('a layout switch in the workspace swaps the skin in place', async ({ page }) => {
    await openRoute(page, '/');
    await openRoute(page, await firstProjectRoute(page));
    const card = page.locator('[data-focus]');
    await expect(card).toHaveAttribute('data-layout', 'retro');
    const xterm = card.locator('[data-xterm]').first();
    await expect(xterm).toBeVisible();
    const terminal = await xterm.getAttribute('data-xterm');
    await card.locator('h1').focus();
    await page.keyboard.press('Alt+Digit1');
    await expect(card).toHaveAttribute('data-layout', 'minimal');
    await expect(card.locator('[data-retro-band]')).toHaveCount(0);
    // The same workspace, not a new one: the terminal kept its pane.
    await expect(card.locator(`[data-xterm="${terminal}"]`)).toBeVisible();
    await page.keyboard.press('Alt+Digit5');
    await expect(card).toHaveAttribute('data-layout', 'retro');
    await expect(card.locator('[data-retro-band]')).toBeVisible();
  });
});

// Grid's workspace skin (DESIGN.md §10.8): the cockpit's phase-in carries into the workspace, the
// panels are holo screens lit by their activity, and Esc steps back to the cockpit.
test.describe('grid at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, layout: 'grid' });

  /** Enters the first node with a Claude session and returns its cockpit. */
  async function enterCockpit(page: Page) {
    await openRoute(page, '/');
    const node = page
      .locator('[data-grid-node]', { has: page.locator('[data-scene-actor^="s:"]') })
      .first();
    await expect(node).toBeVisible();
    const id = await node.getAttribute('data-grid-node');
    if (!id) throw new Error('node without an id');
    await OPENERS.grid.enter?.(page, id);
    return { id, cockpit: page.locator(`[data-grid-cockpit="${id}"]`) };
  }

  test('Open workspace phases the screens into the columns, and Esc returns to the cockpit', async ({
    page,
  }) => {
    const { id, cockpit } = await enterCockpit(page);
    await cockpit.locator('[data-cockpit-open]').click();
    const card = page.locator(`[data-focus="${id}"]`);
    // The card is there at once; a scanline sweeps it while the screens settle, then goes.
    await expect(card.locator('[data-grid-entry]')).toBeAttached();
    expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(card.locator('[data-grid-entry]')).toHaveCount(0);
    await expect(card).toHaveAttribute('data-layout', 'grid');
    await expect(card.locator('[data-grid-band]')).toBeVisible();
    for (const panel of ['Sessions', 'Claude', 'Terminals']) {
      const frame = card.locator(`[data-grid-panel="${panel}"]`);
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute('data-level', /^[0-3]$/);
    }
    // Holo screens: a neon edge, Geist Mono caps title bars, the ground behind them.
    const bar = card.locator('[data-grid-panel="Claude"] .gs-titlebar');
    expect(await bar.evaluate((el) => getComputedStyle(el).textTransform)).toBe('uppercase');
    expect(await bar.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Geist Mono');
    // The active session glows: its highlight takes the neon.
    await expect(card.locator('[data-session-pill]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(page.locator('[data-grid]')).toHaveAttribute('data-grid-entered', id);
    await expect(cockpit.locator('[data-cockpit-open]')).toBeFocused();
  });

  test('a centered screen opens the workspace on its session, and Esc comes back to it', async ({
    page,
  }) => {
    test.slow();
    const { id, cockpit } = await enterCockpit(page);
    await cockpit.locator('[data-grid-screen="claude"] [data-screen-face]').first().click();
    const center = page.locator('[data-grid-center^="s:"]');
    await expect(center).toBeVisible();
    const open = center.locator('[data-center-open]');
    const href = (await open.getAttribute('href'))?.replace(/^#/, '');
    await open.click();
    await expect(page).toHaveURL((url) => url.hash === `#${href}`);
    const card = page.locator(`[data-focus="${id}"]`);
    await expect(card).toHaveAttribute('data-layout', 'grid');
    await expect(card.locator('[data-session][aria-current="page"]')).toBeVisible();
    // Esc from the view itself (the composer keeps its own Esc).
    await card.locator('h1').focus();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(center).toBeVisible();
    await expect(open).toBeFocused();
  });

  test('at Reduced the screens hold still: no sweep, no breathing glow', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
    await openRoute(page, '/');
    await openRoute(page, await firstProjectRoute(page));
    const card = page.locator('[data-focus]');
    await expect(card).toHaveAttribute('data-layout', 'grid');
    await expect(card.locator('[data-grid-entry]')).toHaveCount(0);
    const frames = card.locator('.gs-glow');
    await expect(frames).toHaveCount(3);
    const animations = await frames.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el, '::before').animationName),
    );
    expect(animations.every((name) => name === 'none')).toBe(true);
    // The glow still reads the activity, held at its step: the demo's busy project lights up.
    await expect
      .poll(() => card.locator('.gs-frame:not([data-level="0"])').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
  });
});

// Office's workspace skin (DESIGN.md §10.8): the room view's room shrinks into the header band as
// the monitors rise in, the band's characters select what they are, and Esc returns to the room.
test.describe('office at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, layout: 'office' });

  /** Zooms into the first room with a terminal and returns its id. */
  async function enterRoom(page: Page) {
    await openRoute(page, '/');
    const room = page
      .locator('[data-room]', { has: page.locator('[data-scene-actor^="t:"]') })
      .first();
    await expect(room).toBeVisible();
    const id = await room.getAttribute('data-room');
    if (!id) throw new Error('room without an id');
    await OPENERS.office.enter?.(page, id);
    return id;
  }

  test('Open workspace carries the room into the band, and Esc returns to the room view', async ({
    page,
  }) => {
    const id = await enterRoom(page);
    const open = page.locator(OPENERS.office.link(id));
    const seen = watchEntry(page, 'data-office-entry', 'data-office-ghost');
    await open.click();
    const card = page.locator(`[data-focus="${id}"]`);
    // The card is there at once; the room's still copy moves into the band, then goes.
    expect(await seen).toEqual({ entry: true, ghost: true, opacity: '1' });
    await expect(card.locator('[data-office-entry]')).toHaveCount(0);
    await expect(card).toHaveAttribute('data-layout', 'office');
    const band = card.locator('[data-office-band]');
    await expect(band).toBeVisible();
    await expect(band.locator('[data-kit-nameplate] h1')).toBeVisible();
    await expect(band.locator('[data-band-actor]').first()).toBeVisible();
    expect(await band.locator('[data-band-actor]').count()).toBeLessThanOrEqual(8);
    // Monitors: each panel on a bezel with a power LED; at rest, nothing left transformed.
    for (const panel of ['Sessions', 'Claude', 'Terminals']) {
      const monitor = card.locator(`[data-office-panel="${panel}"]`);
      await expect(monitor).toBeVisible();
      await expect(monitor).toHaveAttribute('data-led', /^(on|work|wait|err)$/);
      expect(await monitor.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    }

    await card.locator('h1').focus();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(page.locator('[data-office]')).toHaveAttribute('data-office-entered', id);
    await expect(open).toBeFocused();
  });

  test('a band character selects its terminal, or its session', async ({ page }) => {
    const id = await enterRoom(page);
    await page.locator(OPENERS.office.link(id)).click();
    const card = page.locator(`[data-focus="${id}"]`);
    await expect(card.locator('[data-office-entry]')).toHaveCount(0);
    const band = card.locator('[data-office-band]');

    await expect(band.locator('[data-band-actor^="t:"]').first()).toBeVisible();
    const tabs = card.locator('[role="tab"][data-tab]');
    await expect(tabs.first()).toBeVisible();
    // Read and click in one step: the band reseats as states change (attention first).
    const clickBand = (kind: 's' | 't') =>
      band.evaluate((el, prefix) => {
        const selected = document
          .querySelector('[role="tab"][data-tab][aria-selected="true"]')
          ?.getAttribute('data-tab');
        const actors = [...el.querySelectorAll<HTMLElement>(`[data-band-actor^="${prefix}:"]`)];
        const pick =
          actors.find((a) => a.dataset.bandActor?.slice(2) !== selected) ?? actors.at(-1);
        pick?.click();
        return pick?.dataset.bandActor?.slice(2) ?? null;
      }, kind);

    const terminalId = await clickBand('t');
    await expect(card.locator(`[role="tab"][data-tab="${terminalId}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const sessionId = await clickBand('s');
    if (sessionId) {
      await expect(page).toHaveURL((url) => url.hash.endsWith(`/s/${sessionId}`));
      await expect(card.locator(`a[data-session="${sessionId}"]`)).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });

  test('at Reduced the workspace cross-fades in: no room move', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
    const id = await enterRoom(page);
    await page.locator(OPENERS.office.link(id)).click();
    const card = page.locator(`[data-focus="${id}"]`);
    await expect(card).toHaveAttribute('data-layout', 'office');
    await expect(card.locator('[data-office-entry]')).toHaveCount(0);
    await expect(card.locator('[data-office-band]')).toBeVisible();
  });
});

// Transit's workspace skin (DESIGN.md §10.8): the line grows from the map into the header band,
// its stations select what they are, its log bins jump to their events, and Esc returns to the
// map with the line's sign focused and lit.
test.describe('transit at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, layout: 'transit' });

  /** Opens the first line that has a terminal from its sign on the map. */
  async function openLine(page: Page) {
    await openRoute(page, '/');
    const line = page
      .locator('[data-transit-line]', {
        has: page.locator('[data-transit-station][data-actor-kind="terminal"]'),
      })
      .first();
    await expect(line).toBeVisible();
    const id = await line.getAttribute('data-transit-line');
    if (!id) throw new Error('line without an id');
    return { id, sign: page.locator(`[data-transit-name="${id}"]`) };
  }

  test('the line grows into the header band, and Esc returns to the map with the line lit', async ({
    page,
  }) => {
    const { id, sign } = await openLine(page);
    const seen = watchEntry(page, 'data-transit-entry', 'data-transit-ghost');
    await sign.click();
    const card = page.locator(`[data-focus="${id}"]`);
    // The card is there at once; a still copy of the line moves into the band, then goes.
    expect(await seen).toEqual({ entry: true, ghost: true, opacity: '1' });
    await expect(card.locator('[data-transit-entry]')).toHaveCount(0);
    await expect(card).toHaveAttribute('data-layout', 'transit');
    const band = card.locator(`[data-transit-band="${id}"]`);
    await expect(band).toBeVisible();
    await expect(band.locator('h1')).toHaveText(
      await sign.locator('.transit-name-text').innerText(),
    );
    // The project's own line: its stations with their trains, and the hour's service log.
    await expect(band.locator('[data-transit-station]').first()).toBeVisible();
    await expect(band.locator('[data-transit-log]')).toBeVisible();
    for (const panel of ['Sessions', 'Claude', 'Terminals']) {
      await expect(card.locator(`[data-transit-panel="${panel}"]`)).toBeVisible();
    }
    // Station signs over the columns, and the session list in the board's words.
    const heading = card.locator('[data-column-heading] > span').first();
    expect(await heading.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
    await expect(card.locator('[data-session-list]')).toBeVisible();
    await expect(card.locator('[data-session-list] [data-status]').first()).toHaveText(
      /At platform|Departing|Due · needs you|Cancelled|In service|Out of service|Held/,
    );

    await card.locator('h1').focus();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(sign).toBeFocused();
    await expect(page.locator(`[data-transit-line="${id}"]`)).toHaveAttribute(
      'data-returned',
      'true',
    );
  });

  test('a station in the band selects its terminal, and a log bin jumps to its event', async ({
    page,
  }) => {
    const { id, sign } = await openLine(page);
    await sign.click();
    const card = page.locator(`[data-focus="${id}"]`);
    const band = card.locator('[data-transit-band]');
    await expect(card.locator('[data-transit-entry]')).toHaveCount(0);

    // A terminal's station selects its tab in the stack, as the tab itself would.
    const station = band.locator('[data-transit-station][data-actor-kind="terminal"]').first();
    const actor = await station.getAttribute('data-transit-station');
    const terminal = actor?.replace(/^t:/, '');
    if (!terminal) throw new Error('station without a terminal');
    await station.click();
    await expect(card.locator(`[role="tab"][data-tab="${terminal}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // A Claude station selects its session.
    const claude = band.locator('[data-transit-station][data-actor-kind="claude"]').first();
    if ((await claude.count()) > 0) {
      const session = (await claude.getAttribute('data-transit-station'))?.replace(/^s:/, '');
      await claude.click();
      await expect(page).toHaveURL(new RegExp(`/s/${session}`));
      await expect(claude).toHaveAttribute('aria-current', 'true');
    }

    // A log bin of a finished turn jumps to its session, like a Pulse dot.
    const bin = band.locator('[data-transit-event][data-session]').last();
    await expect(bin).toBeVisible({ timeout: 20_000 });
    const target = await bin.getAttribute('data-session');
    await bin.click();
    await expect(page).toHaveURL(new RegExp(`/s/${target}`));
    await expect(card.locator(`a[data-session="${target}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the line is one Tab stop, and the arrows move along it', async ({ page }) => {
    const { id, sign } = await openLine(page);
    await sign.click();
    const card = page.locator(`[data-focus="${id}"]`);
    await expect(card.locator('[data-transit-entry]')).toHaveCount(0);
    const line = card.locator('[data-band-line]');
    const items = line.locator('[data-transit-item]');
    // Its first station is the Tab stop; the rest wait for the arrows.
    await expect(line.locator('[tabindex="0"]')).toHaveCount(1);
    await items.first().focus();
    await page.keyboard.press('ArrowLeft');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(items.first()).toBeFocused();
    // Esc still leaves the workspace from inside the line.
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
  });

  test('at Reduced the workspace cross-fades in: no line moving into the band', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
    const { id, sign } = await openLine(page);
    await sign.click();
    const card = page.locator(`[data-focus="${id}"]`);
    await expect(card).toHaveAttribute('data-layout', 'transit');
    await expect(card.locator('[data-transit-entry]')).toHaveCount(0);
    await expect(card.locator('[data-transit-band]')).toBeVisible();
  });
});

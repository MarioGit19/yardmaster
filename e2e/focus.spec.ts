import type { Page } from '@playwright/test';
import {
  expect,
  FOCUS_LAYOUTS,
  type FocusLayout,
  firstProjectRoute,
  openRoute,
  test,
} from './fixtures.js';

/** Each layout's way into a project from its overview: the item, its id, and the link to click. */
const OPENERS: Record<FocusLayout, { item: string; id: string; link: (id: string) => string }> = {
  minimal: { item: '[data-pod]', id: 'data-pod', link: (id) => `[data-pod="${id}"] header a` },
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

// Pods morph into their focus view; other layouts enter through their skin (below).
test.describe('minimal at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the pod morphs into the focus view and back', async ({ page }) => {
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

        const frames = await page.evaluate(
          () => (window as unknown as { __frames: { w: number; resizing: boolean }[] }).__frames,
        );
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
      await page.addInitScript(() => localStorage.setItem('cboard.motion', 'reduced'));
      const opener = OPENERS[layout];
      await openRoute(page, '/');
      const first = page.locator(opener.item).first();
      await expect(first).toBeVisible();
      const id = await first.getAttribute(opener.id);
      if (!id) throw new Error('project without an id');
      const sampling = sampleBoxes(page, `[data-focus="${id}"]`, 400);
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

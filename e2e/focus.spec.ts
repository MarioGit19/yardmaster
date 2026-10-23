import type { Page } from '@playwright/test';
import { expect, openRoute, test } from './fixtures.js';

/** Opens the first pod from the overview by its name link, as a user would. */
async function openFirstPod(page: Page) {
  await openRoute(page, '/');
  const first = page.locator('[data-pod]').first();
  await expect(first).toBeVisible();
  const id = await first.getAttribute('data-pod');
  if (!id) throw new Error('pod without an id');
  await page.locator(`[data-pod="${id}"] header a`).click();
  const card = page.locator(`[data-focus="${id}"]`);
  await expect(card).toBeVisible();
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

test.describe('at 1440', () => {
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

  test('a released handle springs to a snap width and is remembered', async ({ page }) => {
    const { card } = await openFirstPod(page);
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
    const { card } = await openFirstPod(page);
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
    const { card } = await openFirstPod(page);
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
    expect(Math.round(terminals.width)).toBe(Math.min(520, Math.max(300, Math.round(body * 0.3))));
    expect(claude.width).toBeGreaterThan(terminals.width);
    // The card fills the main area inside the page gutters, without page scroll.
    const cardBox = await card.boundingBox();
    expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
  });
}

test('stacked tabs at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { card } = await openFirstPod(page);
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
  const box = await card.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(16);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390 - 16);
});

test('at Reduced the focus view swaps without movement', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('cboard.motion', 'reduced'));
  await openRoute(page, '/');
  const first = page.locator('[data-pod]').first();
  await expect(first).toBeVisible();
  const id = await first.getAttribute('data-pod');
  const sampling = sampleBoxes(page, `[data-focus="${id}"]`, 400);
  await page.locator(`[data-pod="${id}"] header a`).click();
  const widths = (await sampling).map((f) => Math.round(f.w));
  expect(widths.length).toBeGreaterThan(0);
  expect(new Set(widths).size).toBe(1);
});

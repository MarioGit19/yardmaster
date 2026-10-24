import type { Page } from '@playwright/test';
import { type DemoBoard, startBoard } from './board.js';
import { test as base, disableWebgl, expect, signedInState } from './fixtures.js';
import { formatMainThread, mainThread } from './perf.js';

// PRD §9 on the `--demo-stress` board: 10 projects × 6 terminals, two log firehoses at about
// 200 lines/s and four Claude sessions at about 5 tool calls/s, every animation running.
const SAMPLE_MS = 10_000;
const MIN_FPS = 55;
const LONG_TASK_MS = 50;
/** The overview may keep the main thread busy for at most this share of the wall clock. */
const MAX_MAIN_THREAD_SHARE = 0.6;

/** One stress board for this file, so its load is the only one the browser sees. */
let board: DemoBoard | undefined;

const test = base.extend<object, { stressBoard: DemoBoard }>({
  stressBoard: [
    async ({}, use) => {
      board ??= await startBoard({ demo: true, stress: true });
      await use(board);
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ stressBoard }, use) => use(stressBoard.url),
  storageState: async ({ stressBoard }, use) =>
    use(signedInState(stressBoard.url, stressBoard.cookie)),
});

// Stopped as soon as the file is done, not when the worker exits: the parallel suite runs next.
test.afterAll(async () => {
  await board?.stop();
  board = undefined;
});

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

interface FrameStats {
  fps: number;
  worstFrame: number;
  longTasks: number[];
}

/** rAF sampling and long-task observation over `ms`. */
function measure(page: Page, ms: number): Promise<FrameStats> {
  return page.evaluate(
    ({ ms, longTaskMs }) =>
      new Promise<FrameStats>((resolve) => {
        const longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > longTaskMs) longTasks.push(Math.round(entry.duration));
          }
        });
        observer.observe({ type: 'longtask' });
        const stamps: number[] = [];
        const tick = (now: number) => {
          stamps.push(now);
          if (now - (stamps[0] ?? now) < ms) {
            requestAnimationFrame(tick);
            return;
          }
          observer.disconnect();
          const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] ?? t));
          const span = (stamps.at(-1) ?? 0) - (stamps[0] ?? 0);
          resolve({ fps: (gaps.length / span) * 1000, worstFrame: Math.max(...gaps), longTasks });
        };
        requestAnimationFrame(tick);
      }),
    { ms, longTaskMs: LONG_TASK_MS },
  );
}

function report(view: string, stats: FrameStats) {
  console.log(
    `stress ${view}: ${stats.fps.toFixed(1)} fps, worst frame ${stats.worstFrame.toFixed(1)} ms, ` +
      `long tasks > ${LONG_TASK_MS} ms: ${stats.longTasks.length ? stats.longTasks.join(', ') : 'none'}`,
  );
}

/** Every animation runs, whatever the machine's reduced-motion setting. */
async function fullMotion(page: Page) {
  await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'full'));
}

/** Waits until the board is busy: firehoses streaming and sessions running tools. */
async function warmUp(page: Page) {
  await expect(page.locator('[data-pod]')).toHaveCount(10);
  // Let the boot burst (backfill, dev server banners, transcript seeding) settle.
  await page.waitForTimeout(3_000);
}

test('@perf overview keeps 55 fps under the stress load', async ({ page }) => {
  test.slow();
  await fullMotion(page);
  await page.goto('/#/');
  await warmUp(page);

  const stats = await measure(page, SAMPLE_MS);
  report('overview', stats);
  expect(stats.fps).toBeGreaterThanOrEqual(MIN_FPS);
  expect(stats.longTasks).toEqual([]);
});

// The alternative ambient styles (Settings → Appearance → Ambient) under the same load.
for (const ambient of ['veil', 'aurora'] as const) {
  test(`@perf overview keeps 55 fps under the stress load (${ambient} ambient)`, async ({
    page,
  }) => {
    test.slow();
    await fullMotion(page);
    await page.addInitScript((style) => localStorage.setItem('yardmaster.ambient', style), ambient);
    await page.goto('/#/');
    await warmUp(page);
    await expect(page.locator('[data-ambient]')).toHaveAttribute('data-ambient', 'webgl');

    const stats = await measure(page, SAMPLE_MS);
    report(`overview (${ambient})`, stats);
    expect(stats.fps).toBeGreaterThanOrEqual(MIN_FPS);
    expect(stats.longTasks).toEqual([]);
  });
}

// 11.6: the Grid's 3D network (one WebGL context, instanced packets, projected labels).
test('@perf the Grid 3D network keeps 55 fps under the stress load', async ({ page }) => {
  test.slow();
  await fullMotion(page);
  await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'grid'));
  await page.goto('/#/');
  await expect(page.locator('[data-grid-3d][data-ready]')).toBeVisible();
  await expect(page.locator('[data-grid-label]')).toHaveCount(10);
  await expect(page.locator('canvas[data-grid-canvas]')).toHaveCount(1);
  await page.waitForTimeout(3_000);

  const stats = await measure(page, SAMPLE_MS);
  report('grid 3d', stats);
  expect(stats.fps).toBeGreaterThanOrEqual(MIN_FPS);
  expect(stats.longTasks).toEqual([]);
});

// 11.10: every other layout under the same load (the Grid's 2D map without WebGL).
const LAYOUT_ITEMS = {
  office: '[data-room]',
  'grid 2d': '[data-grid-node]',
  transit: '[data-transit-line]',
  retro: '[data-retro-frame]',
} as const;
for (const [name, item] of Object.entries(LAYOUT_ITEMS)) {
  test(`@perf the ${name} layout keeps 55 fps under the stress load`, async ({ page }) => {
    test.slow();
    await fullMotion(page);
    if (name === 'grid 2d') await disableWebgl(page);
    await page.addInitScript(
      (layout) => localStorage.setItem('yardmaster.layout', layout),
      name.split(' ')[0] ?? name,
    );
    await page.goto('/#/');
    await expect(page.locator(item)).toHaveCount(10);
    await page.waitForTimeout(3_000);

    const stats = await measure(page, SAMPLE_MS);
    report(name, stats);
    expect(stats.fps).toBeGreaterThanOrEqual(MIN_FPS);
    expect(stats.longTasks).toEqual([]);
  });
}

test('@perf overview main-thread time under the stress load', async ({ page }) => {
  test.slow();
  await fullMotion(page);
  await page.goto('/#/');
  await warmUp(page);

  const stats = await mainThread(page, SAMPLE_MS);
  console.log(`stress main thread: ${formatMainThread(stats)}`);
  expect(stats.task).toBeLessThan(1000 * MAX_MAIN_THREAD_SHARE);
});

test('@perf focus view keeps 55 fps with a log firehose on screen', async ({ page }) => {
  test.slow();
  await fullMotion(page);
  await page.goto('/#/');
  await warmUp(page);
  const pod = page.locator('[data-pod]', { hasText: 'acme-shop' }).first();
  await pod.locator('header a').click();
  const stack = page.locator('[data-terminal-stack]');
  await expect(stack).toBeVisible();
  await stack.getByRole('tab', { name: /logs/ }).click();
  await expect(stack.locator('[data-xterm]')).toHaveAttribute('data-renderer', /^(webgl|dom)$/);
  await page.waitForTimeout(1_000);

  const stats = await measure(page, SAMPLE_MS);
  report('focus', stats);
  expect(stats.fps).toBeGreaterThanOrEqual(MIN_FPS);
  expect(stats.longTasks).toEqual([]);
});

// 12.6h: the Grid's workspace skin (holo screens lit by activity, the floor) under the same load,
// opened from the 3D cockpit as a user would.
test('@perf the Grid workspace keeps 55 fps with a log firehose on screen', async ({ page }) => {
  test.slow();
  await fullMotion(page);
  await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'grid'));
  await page.goto('/#/');
  await expect(page.locator('[data-grid-3d][data-ready]')).toBeVisible();
  await page.waitForTimeout(3_000);
  const node = page.locator('[data-grid-label] [data-grid-node]', { hasText: 'acme-shop' }).first();
  const id = await node.getAttribute('data-grid-node');
  await page.locator(`[data-grid-node="${id}"]`).focus();
  await page.keyboard.press('Enter');
  await page.locator(`[data-grid-cockpit="${id}"] [data-cockpit-open]`).click();
  const card = page.locator(`[data-focus="${id}"]`);
  await expect(card).toHaveAttribute('data-layout', 'grid');
  const stack = card.locator('[data-terminal-stack]');
  await stack.getByRole('tab', { name: /logs/ }).click();
  await expect(stack.locator('[data-xterm]')).toHaveAttribute('data-renderer', /^(webgl|dom)$/);
  // Lit by the firehose: the glow is up and breathing.
  await expect(card.locator('[data-grid-panel="Terminals"]')).not.toHaveAttribute(
    'data-level',
    '0',
  );
  await page.waitForTimeout(1_000);

  const stats = await measure(page, SAMPLE_MS);
  report('grid focus', stats);
  expect(stats.fps).toBeGreaterThanOrEqual(MIN_FPS);
  expect(stats.longTasks).toEqual([]);
});

test('the expanded Pulse rail measures no text in its steady frames under the stress load', async ({
  page,
}) => {
  test.slow();
  await fullMotion(page);
  await page.addInitScript(() => {
    localStorage.setItem('yardmaster.pulse', 'expanded');
    // Counts the Pulse canvas's frames (one clear each) and its text measurements.
    const counts = { frames: 0, measures: 0 };
    Object.assign(window, { __pulseCounts: counts });
    const proto = CanvasRenderingContext2D.prototype;
    const isPulse = (ctx: CanvasRenderingContext2D) => ctx.canvas.hasAttribute('data-pulse-canvas');
    const { clearRect, measureText } = proto;
    proto.clearRect = function (...args) {
      if (isPulse(this)) counts.frames++;
      return clearRect.apply(this, args);
    };
    proto.measureText = function (...args) {
      if (isPulse(this)) counts.measures++;
      return measureText.apply(this, args);
    };
  });
  await page.goto('/#/');
  await warmUp(page);
  const canvas = page.locator('canvas[data-pulse-canvas]');
  await expect(canvas).toHaveAttribute('data-lanes', /^[1-9]/);

  const read = () =>
    page.evaluate(() => ({ ...(window as unknown as { __pulseCounts: object }).__pulseCounts }));
  const before = (await read()) as { frames: number; measures: number };
  await page.waitForTimeout(5_000);
  const after = (await read()) as { frames: number; measures: number };
  const frames = after.frames - before.frames;
  const measures = after.measures - before.measures;
  console.log(`stress pulse: ${frames} frames, ${measures} measureText calls in 5 s`);
  // Events keep flying in, so the rail paints well beyond its once-a-second drift.
  expect(frames).toBeGreaterThan(10);
  expect(measures).toBe(0);
});

/** Pairs of the given elements whose boxes overlap (by more than `slack` px each way). */
function overlaps(page: Page, selector: string, slack = 0) {
  return page.locator(selector).evaluateAll((els, slack) => {
    const boxes = els
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0);
    const hits: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]?.box;
        const b = boxes[j]?.box;
        if (!a || !b) continue;
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > slack && y > slack) hits.push(`${i}×${j}`);
      }
    }
    return hits;
  }, slack);
}

// DESIGN.md §10.7 on the busy board (10 projects, an hour of stations).
test('the Grid labels never overlap at 1440 with 10 projects', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'grid'));
  await page.goto('/#/');
  await expect(page.locator('[data-grid-3d][data-ready]')).toBeVisible();
  await expect(page.locator('[data-grid-label]')).toHaveCount(10);
  // Lifted labels ease to their place.
  await page.waitForTimeout(1_500);
  // The camera drifts: sample a few moments. A label with no room shrinks to its name, or
  // hides until hovered (`data-crowded`), so the ones on screen never overlap.
  for (let sample = 0; sample < 6; sample++) {
    expect(
      await overlaps(page, '[data-grid-label]:not([data-crowded]) > [data-grid-node]'),
    ).toEqual([]);
    await page.waitForTimeout(500);
  }
});

test('Transit stations and log bins never overlap in a busy hour', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'transit'));
  await page.goto('/#/');
  await expect(page.locator('[data-transit-line]')).toHaveCount(10);
  await page.waitForTimeout(1_000);
  // Events share fixed bins and stations their columns: on one line, nothing sits on another.
  const crowded = await page.locator('[data-transit-line]').evaluateAll((lines) =>
    lines.flatMap((line) => {
      const boxes = [
        ...line.querySelectorAll(
          '[data-transit-event], [data-transit-station], [data-transit-more]',
        ),
      ].map((m) => m.getBoundingClientRect());
      return boxes.flatMap((a, i) =>
        boxes
          .slice(i + 1)
          .filter(
            (b) =>
              Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5,
          )
          .map(() => line.getAttribute('data-transit-line')),
      );
    }),
  );
  expect(await page.locator('[data-transit-event]').count()).toBeGreaterThan(20);
  expect(crowded).toEqual([]);
});

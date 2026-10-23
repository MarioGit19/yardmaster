import { expect, test } from './fixtures.js';
import { formatMainThread, mainThread } from './perf.js';

test.use({ viewport: { width: 1440, height: 900 } });
// Frame-rate checks: one at a time, so they don't share the CPU.
test.describe.configure({ mode: 'serial' });

// The default nebula and the two alternative ambient styles (Settings → Appearance → Ambient).
for (const ambient of ['nebula', 'veil', 'aurora'] as const) {
  test(`30 crew mascots on screen keep the frame rate (${ambient} ambient)`, async ({ page }) => {
    await page.addInitScript((style) => localStorage.setItem('cboard.ambient', style), ambient);
    await page.goto('/#/_tokens');
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Crew mascot' }),
    });
    await section.getByRole('button', { name: '30 on screen' }).click();
    const grid = section.locator('[data-crew-stress]');
    await expect(grid.locator('[data-crew]')).toHaveCount(30);
    await grid.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    // Every stress mascot is on screen and animating (not paused).
    await expect(grid.locator('[data-crew][data-crew-paused]')).toHaveCount(0);
    await page.waitForTimeout(500);
    // The chosen style is the one drawing (no fx stage on screen has taken the WebGL slot).
    const field = page.locator('[data-ambient]');
    await expect(field).toHaveAttribute('data-ambient-style', ambient);
    await expect(field).toHaveAttribute('data-ambient', 'webgl');

    // rAF sampling over 3 s.
    const { fps, worst } = await page.evaluate(
      () =>
        new Promise<{ fps: number; worst: number }>((resolve) => {
          const stamps: number[] = [];
          const tick = (now: number) => {
            stamps.push(now);
            if (now - (stamps[0] ?? now) < 3000) requestAnimationFrame(tick);
            else {
              const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] ?? t));
              const span = (stamps.at(-1) ?? 0) - (stamps[0] ?? 0);
              resolve({ fps: (gaps.length / span) * 1000, worst: Math.max(...gaps) });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
    console.log(`crew stress: ${fps.toFixed(1)} fps, worst frame ${worst.toFixed(1)} ms`);
    expect(fps).toBeGreaterThanOrEqual(55);
  });
}

// 10.4 measured 342–378 ms/s here; 10.8e moved the last SVG loops onto HTML layers.
test('@perf 30 crew mascots main-thread time', async ({ page }) => {
  await page.goto('/#/_tokens');
  const section = page.locator('section', {
    has: page.getByRole('heading', { name: 'Crew mascot' }),
  });
  await section.getByRole('button', { name: '30 on screen' }).click();
  const grid = section.locator('[data-crew-stress]');
  await expect(grid.locator('[data-crew]')).toHaveCount(30);
  await grid.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(grid.locator('[data-crew][data-crew-paused]')).toHaveCount(0);
  await page.waitForTimeout(1_000);

  const stats = await mainThread(page, 5_000);
  console.log(`crew stress main thread: ${formatMainThread(stats)}`);
  expect(stats.task).toBeLessThan(600);
});

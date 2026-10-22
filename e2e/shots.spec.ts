import { expect, firstProjectRoute, openRoute, type Theme, test } from './fixtures.js';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
] as const;
const THEMES: readonly Theme[] = ['dark', 'light'];
const SCREENS = ['overview', 'focus', 'settings'] as const;
const OUT_DIR = new URL('../artifacts/shots/', import.meta.url);

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test.describe(`${theme} ${viewport.width}x${viewport.height}`, () => {
      test.use({ theme, viewport });

      for (const screen of SCREENS) {
        test(screen, async ({ page }) => {
          await openRoute(page, '/');
          if (screen === 'focus') await openRoute(page, await firstProjectRoute(page));
          if (screen === 'settings') await openRoute(page, '/settings');
          // Let entrance motion settle; the capture then freezes whatever still runs.
          await page.waitForTimeout(800);
          const file = `${screen}-${viewport.width}x${viewport.height}-${theme}.png`;
          await page.screenshot({
            path: new URL(file, OUT_DIR).pathname,
            fullPage: true,
            animations: 'disabled',
          });
        });
      }
    });
  }
}

// Ambient field at rest and at full energy (debug slider on /_tokens), and the Reduced field.
test.describe('ambient field', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('energy', async ({ page }) => {
    await page.goto('/#/_tokens');
    const field = page.locator('[data-ambient]');
    await expect(field).toHaveAttribute('data-ambient', 'webgl');
    await expect(field.locator('canvas[data-ready]')).toBeAttached();
    const slider = page.getByLabel('Ambient energy');
    const shoot = async (name: string) => {
      // The uniforms ease toward the new target over ~1.4 s.
      await page.waitForTimeout(3500);
      await page.screenshot({ path: new URL(`${name}.png`, OUT_DIR).pathname });
    };
    await slider.fill('0');
    await shoot('ambient-energy-0');
    await slider.fill('1');
    await page.getByRole('button', { name: 'Attention bloom' }).click();
    await shoot('ambient-energy-1-attention');
  });

  test('reduced', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cboard.motion', 'reduced'));
    await openRoute(page, '/');
    await expect(page.locator('[data-ambient]')).toHaveAttribute('data-ambient', 'css');
    await expect(page.locator('[data-ambient] canvas')).toHaveCount(0);
    await page.screenshot({ path: new URL('ambient-reduced.png', OUT_DIR).pathname });
  });
});

// Every ClaudeOrb state side by side on /_tokens, in both themes and at Reduced.
test.describe('claude orb', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme });
      test('showcase', async ({ page }) => {
        await page.goto('/#/_tokens');
        const section = page.locator('section', {
          has: page.getByRole('heading', { name: 'Claude Orb' }),
        });
        await section.scrollIntoViewIfNeeded();
        await expect(section.locator('[data-orb]')).toHaveCount(18);
        // Past the entrance effects (state switch at 450 ms, ripple 900 ms).
        await page.waitForTimeout(1800);
        await section.screenshot({ path: new URL(`orb-showcase-${theme}.png`, OUT_DIR).pathname });
      });
    });
  }

  test('reduced', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cboard.motion', 'reduced'));
    await page.goto('/#/_tokens');
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Claude Orb' }),
    });
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await section.screenshot({ path: new URL('orb-showcase-reduced.png', OUT_DIR).pathname });
  });
});

// The crew mascot's character sheet on /_tokens: every state at 120/56/24 px.
test.describe('crew mascot', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const sheet = (page: import('@playwright/test').Page) =>
    page.locator('section', { has: page.getByRole('heading', { name: 'Crew mascot' }) });

  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme });
      test('character sheet', async ({ page }) => {
        await page.goto('/#/_tokens');
        const section = sheet(page);
        await section.scrollIntoViewIfNeeded();
        await expect(section.locator('[data-crew]')).toHaveCount(36);
        await page.waitForTimeout(1200);
        await section.screenshot({ path: new URL(`crew-sheet-${theme}.png`, OUT_DIR).pathname });
      });
    });
  }

  test('reduced', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cboard.motion', 'reduced'));
    await page.goto('/#/_tokens');
    const section = sheet(page);
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await section.screenshot({ path: new URL('crew-sheet-reduced.png', OUT_DIR).pathname });
  });
});

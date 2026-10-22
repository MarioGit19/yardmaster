import { firstProjectRoute, openRoute, type Theme, test } from './fixtures.js';

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

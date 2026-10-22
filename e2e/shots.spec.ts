import type { WebSocketRoute } from '@playwright/test';
import { expect, firstProjectRoute, openRoute, type Theme, test } from './fixtures.js';
import { openLongTranscript } from './messages.js';

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

// Terminal lanes on the overview once the sparklines have a few live samples, plus a peek.
test.describe('terminal lanes', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme, viewport: { width: 1440, height: 900 } });
      test('overview and peek', async ({ page }) => {
        await openRoute(page, '/');
        await expect(page.locator('[data-lane]').first()).toBeVisible();
        await page.waitForTimeout(4000);
        await page.screenshot({ path: new URL(`lanes-${theme}.png`, OUT_DIR).pathname });
        const lane = page.locator('[data-lane][data-streaming]').first();
        await lane.locator('[aria-expanded]').hover();
        await expect(page.locator('[data-peek]')).toBeVisible();
        await page.waitForTimeout(600);
        const pod = page.locator('[data-pod]:has([data-open])');
        const box = await pod.boundingBox();
        if (!box) throw new Error('pod not visible');
        await page.screenshot({
          path: new URL(`lane-peek-${theme}.png`, OUT_DIR).pathname,
          clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 140 },
        });
      });
    });
  }
});

// A pod waiting for approval: attention-first order and the amber glow.
test.describe('waiting pod', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme, viewport: { width: 1440, height: 900 } });
      test('overview', async ({ page }) => {
        test.slow();
        await openRoute(page, '/');
        await expect(page.locator('[data-pod][data-tone="wait"]').first()).toBeVisible({
          timeout: 30_000,
        });
        await page.waitForTimeout(1200);
        await page.screenshot({ path: new URL(`overview-waiting-${theme}.png`, OUT_DIR).pathname });
      });
    });
  }
});

// HUD close-ups, the Attention Center opened from the Waiting count, and the reconnect state.
test.describe('hud', () => {
  for (const theme of THEMES) {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ] as const) {
      test.describe(`${theme} ${viewport.width}`, () => {
        test.use({ theme, viewport });
        test('attention', async ({ page }) => {
          test.slow();
          await openRoute(page, '/');
          const waiting = page.locator('[data-hud="waiting"]');
          await expect(waiting.locator('[data-value]')).not.toHaveAttribute('data-value', '0', {
            timeout: 30_000,
          });
          await page.waitForTimeout(800);
          const name = `hud-${viewport.width}-${theme}.png`;
          await page
            .locator('header')
            .first()
            .screenshot({ path: new URL(name, OUT_DIR).pathname, animations: 'disabled' });
          await waiting.click();
          await page.waitForTimeout(800);
          await page.screenshot({
            path: new URL(`attention-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
        });
      });
    }
  }

  test.describe('reconnecting', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test('dark', async ({ page }) => {
      // Proxy the board socket so the test can drop it after the first snapshot, then refuse
      // every reconnect: the board stays on screen, greyed, while the client retries.
      let refuse = false;
      const sockets: WebSocketRoute[] = [];
      await page.routeWebSocket(/\/ws\/ui/, (ws) => {
        if (refuse) return ws.close();
        ws.connectToServer();
        sockets.push(ws);
      });
      await openRoute(page, '/');
      await expect(page.locator('[data-pod]').first()).toBeVisible();
      await page.waitForTimeout(800);
      refuse = true;
      for (const ws of sockets) await ws.close();
      await expect(page.locator('header [data-connection="reconnecting"]')).toBeVisible({
        timeout: 15_000,
      });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: new URL('hud-reconnecting-1440-dark.png', OUT_DIR).pathname,
        animations: 'disabled',
      });
    });
  });
});

// The pod-to-focus morph mid-flight in both directions, and a resize handle being dragged.
test.describe('focus view', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme, viewport: { width: 1440, height: 900 } });
      test('transition', async ({ page }) => {
        await openRoute(page, '/');
        const pod = page.locator('[data-pod]').first();
        await expect(pod).toBeVisible();
        await page.waitForTimeout(800);
        const shot = (name: string) =>
          page.screenshot({ path: new URL(`${name}-${theme}.png`, OUT_DIR).pathname });
        await pod.locator('header a').click();
        await page.waitForTimeout(140);
        await shot('focus-enter-mid');
        await page.waitForTimeout(900);
        const handle = page.locator('[role="separator"][data-resize="right"]');
        await handle.hover();
        await page.waitForTimeout(250);
        await shot('focus-handle-hover');
        await page.mouse.move(600, 600);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(140);
        await shot('focus-exit-mid');
      });
    });
  }
});

// The terminal stack: a tab with typed output and a failed command, the 2×2 grid, the
// interactive-app card, search and the maximized stack.
test.describe('terminal stack', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme, viewport: { width: 1440, height: 900 } });
      test('stack', async ({ page }) => {
        await openRoute(page, '/');
        await openRoute(page, await firstProjectRoute(page));
        const stack = page.locator('[data-terminal-stack]');
        const shot = (name: string) =>
          page.screenshot({
            path: new URL(`${name}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });

        await stack.getByRole('tab', { name: /^zsh\b/ }).click();
        const input = stack.getByRole('textbox', { name: 'Send to zsh' });
        for (const command of ['git status -sb', 'ls', 'pnpm typecheck']) {
          await input.fill(command);
          await input.press('Enter');
          await expect(input).toHaveValue('');
        }
        await input.fill('pnpm');
        await page.waitForTimeout(900);
        await shot('terminals-tab');

        await stack.getByRole('button', { name: 'Search output' }).click();
        await stack.getByRole('searchbox').fill('error');
        await page.waitForTimeout(300);
        await shot('terminals-search');
        await stack.getByRole('searchbox').press('Escape');

        await stack.getByRole('tab', { name: /^claude\b/ }).click();
        await expect(stack.locator('[data-interactive]')).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);
        await shot('terminals-interactive');

        await stack.getByRole('tab', { name: /^next dev\b/ }).click();
        await stack.getByRole('button', { name: 'Show up to four terminals' }).click();
        await page.waitForTimeout(900);
        await shot('terminals-grid');

        await stack.getByRole('button', { name: 'Maximize terminals' }).click();
        await page.waitForTimeout(900);
        await shot('terminals-maximized');
      });
    });
  }
});

// The Claude panel: the latest messages, a scrolled-up view with the jump pill and an open
// thinking block, and the narrow tab layout.
test.describe('claude panel', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        test.describe(`${viewport.width}`, () => {
          test.use({ theme, viewport });
          test('messages', async ({ page }) => {
            const shot = (name: string) =>
              page.screenshot({
                path: new URL(`${name}-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
                animations: 'disabled',
              });
            const list = await openLongTranscript(page);
            await page.waitForTimeout(900);
            await shot('claude-latest');
            if (viewport.width < 1024) return;

            await list.evaluate((el) => el.scrollBy(0, -el.clientHeight * 3));
            await page.waitForTimeout(200);
            for (
              let i = 0;
              i < 40 && (await list.locator('[data-row="thinking"]').count()) === 0;
              i++
            ) {
              await list.evaluate((el) => el.scrollBy(0, -el.clientHeight * 0.8));
              await page.waitForTimeout(60);
            }
            const thinking = list.locator('[data-row="thinking"] button[aria-expanded="false"]');
            if ((await thinking.count()) > 0) await thinking.first().click();
            await page.waitForTimeout(600);
            await shot('claude-history');
          });
        });
      }
    });
  }
});

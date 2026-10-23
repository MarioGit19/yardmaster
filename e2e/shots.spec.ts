import type { WebSocketRoute } from '@playwright/test';
import { expect, firstProjectRoute, openRoute, type Theme, test } from './fixtures.js';
import { openLongTranscript } from './messages.js';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
] as const;
const THEMES: readonly Theme[] = ['dark', 'light'];
const SCREENS = ['overview', 'focus', 'settings', 'welcome'] as const;
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
          if (screen === 'welcome') await openRoute(page, '/welcome');
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
          // D opens the deny reason on the selected card.
          await page.keyboard.press('d');
          await page.keyboard.type('Run it on staging first');
          await page.waitForTimeout(300);
          await page.screenshot({
            path: new URL(`attention-deny-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
          await page.keyboard.press('Escape');
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

// Names: pixel-studio's two unnamed sessions ("Claude", "Claude 2"), ledger-sync's renamed
// one, and orbit-api's `zsh` once renamed to `backend` (20 s into the demo).
test.describe('names', () => {
  for (const theme of THEMES) {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      test.describe(`${theme} ${viewport.width}`, () => {
        test.use({ theme, viewport });
        test('names', async ({ page }) => {
          test.setTimeout(60_000);
          const shot = (name: string) =>
            page.screenshot({
              path: new URL(`${name}-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
              animations: 'disabled',
            });
          const open = async (project: string) => {
            await openRoute(page, '/');
            // The previous project's card leaves first, so names below come from this one.
            await expect(page.locator('[data-focus]')).toHaveCount(0);
            await page.locator('a[href^="#/p/"]', { hasText: project }).first().click();
            await expect(page.locator('[data-focus]')).toHaveCount(1);
          };
          await open('pixel-studio');
          if (viewport.width < 768) await page.getByRole('tab', { name: 'Sessions' }).click();
          const names = page.locator('[data-focus] [data-session-name]');
          await expect(names.filter({ hasText: /^Claude 2$/ })).toHaveCount(1, {
            timeout: 15_000,
          });
          await page.waitForTimeout(600);
          await shot('names-sessions');

          await open('ledger-sync');
          if (viewport.width < 768) await page.getByRole('tab', { name: 'Sessions' }).click();
          await expect(names.filter({ hasText: 'retry-backoff' })).toHaveCount(1, {
            timeout: 15_000,
          });
          await page.waitForTimeout(600);
          await shot('names-renamed-session');

          await open('orbit-api');
          if (viewport.width < 768) await page.getByRole('tab', { name: 'Terminals' }).click();
          await expect(
            page.locator('[data-terminal-stack] [data-terminal-name="backend"]'),
          ).toBeVisible({ timeout: 30_000 });
          await page.waitForTimeout(600);
          await shot('names-terminals');
        });
      });
    }
  }
});

// The terminal stack: a tab with typed output and a failed command, the 2×2 grid, the
// interactive-app card, a Claude terminal beside its chat, search and the maximized stack.
test.describe('terminal stack', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme, viewport: { width: 1440, height: 900 } });
      test('stack', async ({ page }) => {
        // Many steps, and it shares the CPU with the other shots.
        test.slow();
        await openRoute(page, '/');
        await openRoute(page, await firstProjectRoute(page));
        const stack = page.locator('[data-terminal-stack]');
        const shot = (name: string) =>
          page.screenshot({
            path: new URL(`${name}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });

        await stack.locator('[role="tab"][data-terminal-name="zsh"]').click();
        const input = stack.getByRole('textbox', { name: 'Send to acme-shop · zsh' });
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

        // A Claude terminal shows its chat (or its raw TUI), never the card: run htop instead.
        await input.fill('htop');
        await input.press('Enter');
        await expect(stack.locator('[data-interactive]')).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);
        await shot('terminals-interactive');
        await stack.getByRole('button', { name: 'Send Ctrl+C' }).click();
        await expect(stack.locator('[data-interactive]')).toHaveCount(0);

        // With its session in the Claude column, the pane points to it.
        const claude = stack.locator('[role="tab"][data-terminal-name="claude"]');
        await claude.click();
        await page
          .locator(`a[data-session="${await claude.getAttribute('data-claude-tab')}"]`)
          .click();
        await expect(stack.locator('[data-chat-beside]')).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(600);
        await shot('terminals-claude');

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

// Every tool card variant on /_tokens: as they first render, then opened with the split diff.
test.describe('tool cards', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const showcase = (page: import('@playwright/test').Page) =>
    page.locator('section', { has: page.getByRole('heading', { name: 'Tool cards' }) });

  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme });
      test('showcase', async ({ page }) => {
        // Highlighting runs in a worker that shares the CPU with the other shots.
        test.slow();
        await page.goto('/#/_tokens');
        const section = showcase(page);
        await section.scrollIntoViewIfNeeded();
        await expect(section.locator('[data-tool-kind]')).toHaveCount(14);
        // Code highlights in a worker; give it a moment.
        await expect(
          section.locator('[data-tool-kind="edit"] [data-diff] span[style]').first(),
        ).toBeVisible();
        await page.waitForTimeout(400);
        await section.screenshot({ path: new URL(`tool-cards-${theme}.png`, OUT_DIR).pathname });

        const closed = section.locator('button[aria-expanded="false"]:not([disabled])');
        for (let i = 0; i < 20 && (await closed.count()) > 0; i++) await closed.first().click();
        await section.getByRole('radio', { name: 'split' }).first().click();
        await page.waitForTimeout(500);
        await section.screenshot({
          path: new URL(`tool-cards-open-${theme}.png`, OUT_DIR).pathname,
        });
      });
    });
  }

  test('replay', async ({ page }) => {
    await page.goto('/#/_tokens');
    const section = showcase(page);
    await section.scrollIntoViewIfNeeded();
    await section.getByRole('button', { name: 'Replay entrance' }).click();
    await page.waitForTimeout(90);
    await section.screenshot({ path: new URL('tool-cards-enter-mid.png', OUT_DIR).pathname });
  });
});

// The command palette: browsing over the overview, a fuzzy search in the focus view, the
// new-session prompt, the phone layout and a frame of the entrance.
test.describe('command palette', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        test.describe(`${viewport.width}`, () => {
          test.use({ theme, viewport });
          test('palette', async ({ page }) => {
            const shot = (name: string) =>
              page.screenshot({
                path: new URL(`${name}-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
                animations: 'disabled',
              });
            const palette = page.getByRole('dialog', { name: 'Command palette' });
            const input = palette.getByRole('combobox');

            await openRoute(page, '/');
            await page.waitForTimeout(600);
            await page.keyboard.press('ControlOrMeta+K');
            await expect(palette).toBeVisible();
            await page.waitForTimeout(400);
            await shot('palette-browse');

            await input.fill('acme');
            await page.waitForTimeout(200);
            await shot('palette-search');
            await page.keyboard.press('Escape');

            await openRoute(page, await firstProjectRoute(page));
            await page.waitForTimeout(800);
            await page.keyboard.press('ControlOrMeta+K');
            await input.fill('re');
            await page.waitForTimeout(300);
            await shot('palette-focus');

            await input.fill('new session');
            await page.keyboard.press('Enter');
            await page.keyboard.type('Add a coupon field to the checkout');
            await page.waitForTimeout(200);
            await shot('palette-prompt');
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await expect(palette).toBeHidden();

            if (viewport.width === 1440) {
              await page.keyboard.press('ControlOrMeta+K');
              await page.waitForTimeout(70);
              await page.screenshot({
                path: new URL(`palette-enter-mid-${theme}.png`, OUT_DIR).pathname,
              });
            }
          });
        });
      }
    });
  }
});

// The Pulse rail with a hovered dot's tooltip, and the Errors filter.
test.describe('pulse rail', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme });

      test('tooltip', async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('cboard.pulse', 'expanded'));
        await openRoute(page, '/');
        const rail = page.locator('[data-pulse]');
        const canvas = rail.locator('canvas[data-pulse-canvas]');
        await expect
          .poll(async () => Number(await canvas.getAttribute('data-dots')))
          .toBeGreaterThan(0);
        await rail.getByRole('application').focus();
        await page.keyboard.press('End');
        for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
        await expect(rail.locator('[data-pulse-tooltip]')).toBeVisible();
        await rail.screenshot({
          path: new URL(`pulse-tooltip-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
        await rail.locator('[data-filter="errors"]').click();
        await page.waitForTimeout(300);
        await rail.screenshot({
          path: new URL(`pulse-errors-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
      });
    });
  }
});

// The focus view's left column: live sessions, the session history (one row hovered so its
// resume actions show) and the git panel; plus the Sessions tab on a phone.
test.describe('git and history', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme, viewport: { width: 1440, height: 1100 } });
      test('left column', async ({ page }) => {
        await openRoute(page, '/');
        await openRoute(page, await firstProjectRoute(page));
        const history = page.locator('[data-history-list]');
        await expect(history.locator('[data-history]').first()).toBeVisible();
        await expect(page.locator('[data-git-panel]')).toBeVisible();
        await history.locator('[data-history]').nth(1).hover();
        await page.waitForTimeout(400);
        const column = page.locator('.focus-col').filter({ has: history });
        await column.screenshot({
          path: new URL(`git-history-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
      });
    });
  }

  test.describe('phone', () => {
    test.use({ theme: 'dark', viewport: { width: 390, height: 844 } });
    test('sessions tab', async ({ page }) => {
      await openRoute(page, '/');
      await openRoute(page, await firstProjectRoute(page));
      await page.getByRole('tab', { name: 'Sessions' }).click();
      await expect(page.locator('[data-history]').first()).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({
        path: new URL('git-history-390-dark.png', OUT_DIR).pathname,
        fullPage: true,
        animations: 'disabled',
      });
    });
  });
});

// Activity states side by side (DESIGN.md §4.10): busy pods with the border light and live
// captions, waiting and crashed pods, and the quiet, dimmed one. Motion stays on for these.
test.describe('activity', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme, viewport: { width: 1440, height: 900 } });
      test('overview', async ({ page }) => {
        await openRoute(page, '/');
        await expect(page.locator('[data-activity-border="spin"]').first()).toBeAttached();
        await page.waitForTimeout(1500);
        await page.screenshot({ path: new URL(`activity-${theme}.png`, OUT_DIR).pathname });
        const shootPod = async (selector: string, name: string) => {
          const box = await page.locator(selector).first().boundingBox();
          if (!box) return;
          await page.screenshot({
            path: new URL(`activity-${name}-${theme}.png`, OUT_DIR).pathname,
            clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 },
          });
        };
        await shootPod('[data-pod]:has([data-activity-border="spin"])', 'busy');
        await shootPod('[data-pod][data-crashed]', 'crashed');
      });
    });
  }
});

// The `?worst=1` demo board (PLAN 7.14): worst-case names, counts and missing fields at every
// width, plus the focus view of the longest project, the Attention Center and a lane peek.
test.describe('worst case', () => {
  // Ten heavy pages: one worker, in turn, so the rest of the shots keep their CPU.
  test.describe.configure({ mode: 'serial' });
  const WORST_WIDTHS = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ] as const;
  const openWorst = async (page: import('@playwright/test').Page, route = '/') => {
    await page.goto(`/?worst=1#${route}`);
    await expect(page.locator('a[href^="#/p/"]').first()).toBeVisible();
  };

  for (const theme of THEMES) {
    for (const viewport of WORST_WIDTHS) {
      test.describe(`${theme} ${viewport.width}`, () => {
        test.use({ theme, viewport });
        test('overview and focus', async ({ page }) => {
          test.slow();
          const shot = (name: string, fullPage = true) =>
            page.screenshot({
              path: new URL(`worst-${name}-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
              fullPage,
              animations: 'disabled',
            });
          await openWorst(page);
          await expect(page.locator('[data-pod]')).toHaveCount(6);
          await page.waitForTimeout(800);
          await shot('overview');
          // The board scrolls inside its own column: the lower pods get a shot of their own.
          await page.locator('main').evaluate((el) => {
            const scroller = [el, ...el.querySelectorAll('*')].find(
              (node) =>
                node.scrollHeight > node.clientHeight + 1 &&
                getComputedStyle(node).overflowY !== 'visible',
            );
            scroller?.scrollTo(0, scroller.scrollHeight);
          });
          await page.waitForTimeout(300);
          await shot('overview-end', false);
          await page.locator('main').evaluate((el) => {
            for (const node of [el, ...el.querySelectorAll('*')]) node.scrollTop = 0;
          });

          const lane = page.locator('[data-lane]').first();
          await lane.locator('[aria-expanded]').focus();
          await page.keyboard.press('Enter');
          await expect(page.locator('[data-peek]')).toBeVisible();
          await page.waitForTimeout(400);
          const pod = page.locator('[data-pod]:has([data-open])');
          const box = await pod.boundingBox();
          if (box) {
            await page.screenshot({
              path: new URL(`worst-peek-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
              clip: {
                x: Math.max(0, box.x - 8),
                y: box.y - 8,
                width: Math.min(viewport.width, box.width + 16),
                height: box.height + 140,
              },
            });
          }
          await page.keyboard.press('Escape');

          await page.locator('[data-hud="waiting"]').click();
          await page.waitForTimeout(800);
          await shot('attention', false);
          await page.keyboard.press('Escape');

          const longest = await page
            .locator('[data-pod][aria-label^="northwind"] header a')
            .getAttribute('href');
          if (!longest) throw new Error('no pod link');
          await openWorst(page, longest.slice(1));
          // No hover tooltip left over from the HUD click.
          await page.mouse.move(viewport.width / 2, viewport.height - 4);
          await page.waitForTimeout(1200);
          await shot('focus');
        });
      });
    }
  }
});

// The composer: a terminal session's composer, a new session, and a board session mid-stream.
test.describe('composer', () => {
  for (const theme of THEMES) {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      test.describe(`${theme} ${viewport.width}`, () => {
        test.use({ theme, viewport });
        test('composer', async ({ page }) => {
          const shot = (name: string) =>
            page.screenshot({
              path: new URL(`${name}-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
              animations: 'disabled',
            });
          await openRoute(page, '/');
          await openRoute(page, await firstProjectRoute(page));
          const narrow = viewport.width < 1024;
          if (narrow) await page.getByRole('tab', { name: 'Sessions' }).click();
          // Parallel shots start board sessions in this project too, and the demo's Claude
          // sometimes exits (then relaunches): pick a terminal session that is running.
          const forkable = page
            .locator('[data-focus] a[data-session]')
            .filter({ hasNot: page.locator('[data-origin="board"]') })
            .filter({ hasNotText: 'Ended' })
            .first();
          await forkable.click({ timeout: 40_000 });
          if (narrow) await page.getByRole('tab', { name: 'Claude' }).click();
          // Typing into the terminal, or (mid-request) the approval in its place.
          await expect(
            page
              .locator('[data-session-panel] form[data-composer], [data-terminal-approval]')
              .first(),
          ).toBeVisible();
          await page.waitForTimeout(600);
          await shot('composer-terminal');

          if (narrow) await page.getByRole('tab', { name: 'Sessions' }).click();
          await page.locator('[data-new-session]').click();
          const input = page.getByRole('textbox', { name: 'First message for a new session' });
          await input.fill('Tidy up the cart totals and keep the public API the same.');
          await page.waitForTimeout(300);
          await shot('composer-new');
          await input.press('Enter');
          const tail = page.locator('[data-session-panel] [data-row="tail"]');
          await expect(tail).toBeVisible({ timeout: 15_000 });
          await page.waitForTimeout(1_200);
          await shot('composer-streaming');
        });

        test('fork bar', async ({ page }) => {
          // Only this page sees replies off, so parallel shots keep the terminal composer.
          await page.route('**/api/settings', async (route) => {
            if (route.request().method() !== 'GET') return route.fallback();
            const response = await route.fetch();
            await route.fulfill({
              response,
              json: { ...(await response.json()), terminalReply: false },
            });
          });
          await openRoute(page, '/');
          await openRoute(page, await firstProjectRoute(page));
          const narrow = viewport.width < 1024;
          if (narrow) await page.getByRole('tab', { name: 'Sessions' }).click();
          await page
            .locator('[data-focus] a[data-session]')
            .filter({ hasNot: page.locator('[data-origin="board"]') })
            .filter({ hasNotText: 'Ended' })
            .first()
            .click({ timeout: 40_000 });
          if (narrow) await page.getByRole('tab', { name: 'Claude' }).click();
          // On phones the Terminals tab holds the same chat, hidden.
          await expect(page.locator('[data-fork-bar]').filter({ visible: true })).toBeVisible();
          await page.waitForTimeout(600);
          await page.screenshot({
            path: new URL(`composer-fork-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });

          // The fork: its own "Claude N", "Forked from …", and the parent's messages dimmed
          // above the "Forked here" divider.
          await page
            .locator('[data-fork-bar]')
            .filter({ visible: true })
            .getByRole('button', { name: 'Fork into the board' })
            .click();
          await expect(page.locator('[data-fork-divider]').filter({ visible: true })).toBeVisible({
            timeout: 15_000,
          });
          await page.waitForTimeout(600);
          await page.screenshot({
            path: new URL(`composer-forked-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
        });

        test('interrupted session', async ({ page }) => {
          await openRoute(page, '/');
          const href = await page
            .locator('a[href^="#/p/"]', { hasText: 'docs-site' })
            .first()
            .getAttribute('href');
          await openRoute(page, (href ?? '#/').slice(1));
          const narrow = viewport.width < 1024;
          if (narrow) await page.getByRole('tab', { name: 'Sessions' }).click();
          const row = page.locator('[data-focus] a[data-session]', { hasText: 'Interrupted' });
          if (!narrow) {
            await page.waitForTimeout(400);
            await page.screenshot({
              path: new URL(`session-interrupted-row-${viewport.width}-${theme}.png`, OUT_DIR)
                .pathname,
              animations: 'disabled',
            });
          }
          await row.click();
          if (narrow) await page.getByRole('tab', { name: 'Claude' }).click();
          await expect(page.locator('[data-resume-bar]').filter({ visible: true })).toBeVisible();
          await page.waitForTimeout(600);
          await page.screenshot({
            path: new URL(`session-interrupted-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
        });
      });
    }
  }
});

// The hooks install confirm dialog with its settings.json diff (the demo's synthetic file).
test.describe('hooks install dialog', () => {
  for (const theme of THEMES) {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      test.describe(`${theme} ${viewport.width}x${viewport.height}`, () => {
        test.use({ theme, viewport });
        test('dialog', async ({ page }) => {
          await openRoute(page, '/welcome');
          await page
            .locator('[data-step="hooks"]')
            .getByRole('button', { name: 'Install hooks' })
            .click();
          await expect(page.locator('[data-hooks-dialog]')).toBeVisible();
          await page.waitForTimeout(500);
          await page.screenshot({
            path: new URL(`hooks-dialog-${viewport.width}x${viewport.height}-${theme}.png`, OUT_DIR)
              .pathname,
            animations: 'disabled',
          });
        });
      });
    }
  }
});

// The fx effects on /_tokens (DESIGN.md §3 "Third-party effects") at every motion level: text
// effects after each has played, every background, and the phone interactions mid-gesture.
test.describe('fx showcase', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const section = (page: import('@playwright/test').Page, name: string) =>
    page.locator('section', { has: page.getByRole('heading', { name }) });
  const BACKGROUNDS = ['DarkVeil', 'SoftAurora', 'FaultyTerminal', 'RippleGrid', 'LightTunnel'];

  for (const level of ['full', 'reduced', 'off'] as const) {
    test(level, async ({ page }) => {
      test.slow();
      await page.addInitScript((value) => localStorage.setItem('cboard.motion', value), level);
      await page.goto('/#/_tokens');

      const text = section(page, 'Text effects');
      await text.scrollIntoViewIfNeeded();
      await text.getByRole('button', { name: 'Raise an error' }).click();
      await text.getByRole('button', { name: 'Next status' }).click();
      await text.getByRole('button', { name: 'Next caption' }).click();
      // Mid-resolve and mid-flip at Full; already settled below.
      await page.waitForTimeout(120);
      await text.screenshot({ path: new URL(`fx-text-mid-${level}.png`, OUT_DIR).pathname });
      await page.waitForTimeout(900);
      await text.screenshot({ path: new URL(`fx-text-${level}.png`, OUT_DIR).pathname });

      const backgrounds = section(page, 'Backgrounds');
      await backgrounds.scrollIntoViewIfNeeded();
      for (const name of BACKGROUNDS) {
        await backgrounds.getByRole('button', { name, exact: true }).click();
        if (name === 'RippleGrid' && level === 'full') {
          await backgrounds.getByRole('button', { name: 'Ripple', exact: true }).click();
        }
        if (name === 'LightTunnel' && level === 'full') {
          await backgrounds.getByRole('button', { name: 'Dive', exact: true }).click();
        }
        await page.waitForTimeout(level === 'full' ? 600 : 300);
        await backgrounds.screenshot({
          path: new URL(`fx-bg-${name}-${level}.png`, OUT_DIR).pathname,
        });
      }

      const phone = section(page, 'Phone interactions');
      await phone.scrollIntoViewIfNeeded();
      const hold = phone.getByRole('button', { name: /Hold to stop/ });
      await hold.hover();
      await page.mouse.down();
      await page.waitForTimeout(600);
      await phone.screenshot({ path: new URL(`fx-phone-holding-${level}.png`, OUT_DIR).pathname });
      await page.mouse.up();
      // Drag the approval two thirds of the way to Allow, without letting go.
      const card = phone.getByText('pnpm db:migrate');
      const box = await card.boundingBox();
      if (box) {
        await page.mouse.move(box.x + 20, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 140, box.y + box.height / 2, { steps: 8 });
        await page.waitForTimeout(150);
        await phone.screenshot({ path: new URL(`fx-phone-swipe-${level}.png`, OUT_DIR).pathname });
        await page.mouse.up();
      }
    });
  }

  test('light', async ({ page }) => {
    test.slow();
    await page.addInitScript(() => {
      localStorage.setItem('cboard.theme', 'light');
      localStorage.setItem('cboard.motion', 'full');
    });
    await page.goto('/#/_tokens');
    const backgrounds = section(page, 'Backgrounds');
    await backgrounds.scrollIntoViewIfNeeded();
    for (const name of BACKGROUNDS) {
      await backgrounds.getByRole('button', { name, exact: true }).click();
      await page.waitForTimeout(600);
      await backgrounds.screenshot({ path: new URL(`fx-bg-${name}-light.png`, OUT_DIR).pathname });
    }
    const text = section(page, 'Text effects');
    await text.scrollIntoViewIfNeeded();
    await text.screenshot({ path: new URL('fx-text-light.png', OUT_DIR).pathname });
  });
});

// The alternative ambient styles behind the overview, idle-ish demo board.
test.describe('ambient styles', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  for (const style of ['veil', 'aurora', 'none'] as const) {
    test(style, async ({ page }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('cboard.ambient', value);
        localStorage.setItem('cboard.motion', 'full');
      }, style);
      await openRoute(page, '/');
      if (style !== 'none') {
        await expect(page.locator('[data-ambient]')).toHaveAttribute('data-ambient', 'webgl');
        await expect(page.locator('[data-ambient] canvas[data-ready]')).toBeAttached();
      }
      await page.waitForTimeout(2500);
      await page.screenshot({ path: new URL(`ambient-${style}.png`, OUT_DIR).pathname });
    });
  }
});

// A terminal running claude (10.9): its tab, its chat (beside, or in the pane on phones), the raw
// TUI, and the new-terminal popover.
test.describe('claude terminals', () => {
  for (const theme of THEMES) {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      test.describe(`${theme} ${viewport.width}`, () => {
        test.use({ theme, viewport });
        test('claude terminal', async ({ page }) => {
          const shot = (name: string) =>
            page.screenshot({
              path: new URL(`${name}-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
              animations: 'disabled',
            });
          await openRoute(page, '/');
          await openRoute(page, await firstProjectRoute(page));
          if (viewport.width < 1024) await page.getByRole('tab', { name: 'Terminals' }).click();
          const stack = page.locator('[data-terminal-stack]');
          const tab = stack.locator('[data-claude-tab]').first();
          await expect(tab).toBeVisible({ timeout: 30_000 });
          const sessionId = await tab.getAttribute('data-claude-tab');
          const wide = viewport.width >= 1024;
          // The Claude column on a new session's composer, so the stack shows the chat itself.
          if (wide) await page.locator('[data-new-session]').click();
          await tab.click();
          await expect(
            stack.locator(`[data-pane] [data-session-panel="${sessionId}"]`),
          ).toBeVisible();
          await page.mouse.move(viewport.width / 2, viewport.height - 4);
          await page.waitForTimeout(1200);
          await shot('claude-terminal');

          if (wide) {
            // Its row moves the chat to the Claude column; the stack points there.
            await page.locator(`[data-focus] a[data-session="${sessionId}"]`).click();
            await expect(stack.locator('[data-chat-beside]')).toBeVisible();
            await page.mouse.move(viewport.width / 2, viewport.height - 4);
            await page.waitForTimeout(800);
            await shot('claude-terminal-beside');
            await stack.getByRole('button', { name: 'Show here instead' }).click();
            await expect(
              stack.locator(`[data-pane] [data-session-panel="${sessionId}"]`),
            ).toBeVisible();
          }

          await stack.getByRole('button', { name: 'Raw terminal' }).click();
          await page.waitForTimeout(800);
          await shot('claude-terminal-raw');
          await stack.getByRole('button', { name: 'Chat' }).click();

          await stack.getByRole('button', { name: 'New terminal' }).click();
          await expect(page.locator('[data-new-terminal-popover]')).toBeVisible();
          await page.waitForTimeout(600);
          await shot('new-terminal');
        });
      });
    }
  }
});

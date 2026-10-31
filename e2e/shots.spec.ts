import { devices, type WebSocketRoute } from '@playwright/test';
import { startBoard } from './board.js';
import {
  disableWebgl,
  expect,
  FOCUS_LAYOUTS,
  type FocusLayout,
  firstProjectRoute,
  openRoute,
  signedInState,
  type Theme,
  test,
} from './fixtures.js';
import { openLongTranscript, scrollToTurnHead } from './messages.js';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
] as const;
const THEMES: readonly Theme[] = ['dark', 'light'];
const SCREENS = ['overview', 'focus', 'settings', 'welcome'] as const;
const OUT_DIR = new URL('../artifacts/shots/', import.meta.url);

type Page = import('@playwright/test').Page;

/** A project's session links: rows in the focus view, or cards on a phone's project hub. */
const sessionLinks = (page: Page, phone: boolean) =>
  phone
    ? page.locator('[data-hub] a[data-hub-kind="session"]')
    : page.locator('[data-focus] a[data-session]');

/** A terminal session that is running (not a board one, not ended), on either. */
const runningTerminalSession = (page: Page, phone: boolean) =>
  (phone
    ? page.locator('[data-hub] a[data-hub-kind="session"][data-origin="terminal"]')
    : sessionLinks(page, false).filter({ hasNot: page.locator('[data-origin="board"]') })
  )
    .filter({ hasNotText: 'Ended' })
    .first();

/** Opens the blank new-session composer: the column's button, or + New on a phone. */
async function newSession(page: Page, phone: boolean) {
  if (!phone) return page.locator('[data-new-session]').click();
  const back = page.locator('[data-workspace-page] [data-workspace-back]');
  if (await back.isVisible()) await back.click();
  await page.locator('[data-hub-new]').click();
  await page.locator('[data-new-claude]').click();
}

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

// The board asks a browser without a live session to sign in again; a phone (over its ts.net name)
// to pair again. Settings' full-page shots above carry the signed-in browsers list.
test.describe('sign in again', () => {
  for (const theme of THEMES) {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      test(`${viewport.width}-${theme}`, async ({ browser, baseURL }) => {
        const context = await browser.newContext({
          baseURL,
          viewport,
          colorScheme: theme,
          // Not signed in: the fixtures' session would otherwise carry over.
          storageState: { cookies: [], origins: [] },
        });
        await context.addInitScript(
          (value) => localStorage.setItem('yardmaster.theme', value),
          theme,
        );
        try {
          const page = await context.newPage();
          await page.goto('/');
          await expect(page.locator('[data-sign-in]')).toBeVisible();
          await page.waitForTimeout(600);
          await page.screenshot({
            path: new URL(`sign-in-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
        } finally {
          await context.close();
        }
      });
    }
  }
});

// Settings → Data and security: every signed-in browser and phone, this one marked.
test.describe('signed-in browsers', () => {
  for (const theme of THEMES) {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      test.describe(`${viewport.width}-${theme}`, () => {
        test.use({ theme, viewport });
        test('settings', async ({ page }) => {
          await openRoute(page, '/settings');
          const section = page.getByRole('region', { name: 'Data and security' });
          await section.locator('[data-setting="sessions"] [data-current]').waitFor();
          await section.scrollIntoViewIfNeeded();
          await page.waitForTimeout(400);
          await section.screenshot({
            path: new URL(`settings-sessions-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
        });
      });
    }
  }
});

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
    await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
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
    await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
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
    await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
    await page.goto('/#/_tokens');
    const section = sheet(page);
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await section.screenshot({ path: new URL('crew-sheet-reduced.png', OUT_DIR).pathname });
  });
});

// The Office art kit on /_tokens: every ops state at 120/56/24 px, every prop and the rooms.
test.describe('office kit', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const sheet = (page: import('@playwright/test').Page) =>
    page.locator('section', { has: page.getByRole('heading', { name: 'Office kit' }) });

  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme });
      test('kit sheet', async ({ page }) => {
        await page.goto('/#/_tokens');
        const section = sheet(page);
        await section.scrollIntoViewIfNeeded();
        // 7 states × 3 sizes.
        await expect(section.locator('[data-ops-sheet] [data-ops]')).toHaveCount(21);
        await page.waitForTimeout(1200);
        await section.screenshot({ path: new URL(`office-kit-${theme}.png`, OUT_DIR).pathname });
        await section
          .locator('[data-ops-sheet]')
          .screenshot({ path: new URL(`office-ops-${theme}.png`, OUT_DIR).pathname });
      });
    });
  }

  test('reduced', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
    await page.goto('/#/_tokens');
    const section = sheet(page);
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await section.screenshot({ path: new URL('office-kit-reduced.png', OUT_DIR).pathname });
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
        await lane.locator('[aria-expanded]:not([data-inspect])').first().hover();
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

// The lane activity track once the CPU has enough samples to draw a line.
test.describe('lane activity', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme, viewport: { width: 1440, height: 900 } });
      test('cpu line and ticks', async ({ page }) => {
        test.setTimeout(180_000);
        await openRoute(page, '/');
        await expect(page.locator('[data-sparkline="line"]').first()).toBeAttached({
          timeout: 150_000,
        });
        await page.waitForTimeout(600);
        await page.screenshot({ path: new URL(`lane-activity-${theme}.png`, OUT_DIR).pathname });
      });
    });
  }
});

// Each density on the overview and the phone's Projects list.
test.describe('density', () => {
  for (const theme of THEMES) {
    for (const density of ['comfortable', 'compact', 'list']) {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        test.describe(`${density} ${viewport.width} ${theme}`, () => {
          test.use({ theme, viewport });
          test('overview', async ({ page }) => {
            await page.addInitScript(
              (value) => localStorage.setItem('yardmaster.density', value),
              density,
            );
            await openRoute(page, '/');
            await expect(page.locator('[data-pod]').first()).toBeVisible();
            await page.waitForTimeout(800);
            const name = `density-${density}-${viewport.width}-${theme}`;
            await page.screenshot({ path: new URL(`${name}.png`, OUT_DIR).pathname });
            if (viewport.width > 500) return;
            await openRoute(page, '/projects');
            await expect(page.locator('[data-phone-project]').first()).toBeVisible();
            await page.screenshot({ path: new URL(`${name}-list.png`, OUT_DIR).pathname });
          });
        });
      }
    }
  }
});

// A pod waiting for approval: the amber glow, with the strip above the grid.
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

// The Needs you strip above every layout, and at the top of the phone's overview.
test.describe('needs you strip', () => {
  for (const theme of THEMES) {
    for (const layout of ['minimal', 'office', 'grid', 'transit', 'retro']) {
      test.describe(`${theme} ${layout}`, () => {
        test.use({ theme, viewport: { width: 1440, height: 900 } });
        test('overview', async ({ page }) => {
          test.slow();
          await page.addInitScript((id) => localStorage.setItem('yardmaster.layout', id), layout);
          await openRoute(page, '/');
          await expect(page.locator('[data-strip-item]').first()).toBeVisible({ timeout: 30_000 });
          await page.waitForTimeout(800);
          await page.screenshot({
            path: new URL(`strip-${layout}-${theme}.png`, OUT_DIR).pathname,
          });
        });
      });
    }
    test.describe(`${theme} phone`, () => {
      test.use({ theme, viewport: { width: 390, height: 844 }, hasTouch: true });
      test('overview', async ({ page }) => {
        test.slow();
        await openRoute(page, '/');
        await expect(page.locator('[data-strip-item]').first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(800);
        await page.screenshot({ path: new URL(`strip-phone-${theme}.png`, OUT_DIR).pathname });
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
          const waiting = page.locator('[data-hud="needs-you"]');
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
        test('recap', async ({ page }) => {
          test.slow();
          await openRoute(page, '/');
          await expect(page.locator('[data-strip-item]').first()).toBeVisible({ timeout: 30_000 });
          await page.evaluate(() => {
            localStorage.setItem('yardmaster.recap.lastActive', String(Date.now() - 30 * 60_000));
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await expect(page.locator('[data-recap]')).toBeVisible();
          await page.waitForTimeout(800);
          await page.screenshot({
            path: new URL(`recap-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
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
          // Phones list the sessions on the project hub's cards.
          const names = page.locator('[data-focus] :is([data-session-name], [data-hub-name])');
          await expect(names.filter({ hasText: /^Claude 2$/ })).toHaveCount(1, {
            timeout: 15_000,
          });
          await page.waitForTimeout(600);
          await shot('names-sessions');

          await open('ledger-sync');
          await expect(names.filter({ hasText: 'retry-backoff' })).toHaveCount(1, {
            timeout: 15_000,
          });
          await page.waitForTimeout(600);
          await shot('names-renamed-session');

          await open('orbit-api');
          await expect(
            page.locator(
              viewport.width < 768
                ? '[data-hub] [data-hub-kind="terminal"] [data-hub-name]:text-is("backend")'
                : '[data-terminal-stack] [data-terminal-name="backend"]',
            ),
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
        await page.getByRole('button', { name: 'Show up to four terminals' }).click();
        await page.waitForTimeout(900);
        await shot('terminals-grid');

        await page.getByRole('button', { name: 'Maximize terminals' }).click();
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
        await page.addInitScript(() => localStorage.setItem('yardmaster.pulse', 'expanded'));
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
        await history.locator('[data-history]').nth(1).hover();
        await page.waitForTimeout(400);
        const column = page.locator('.focus-col').filter({ has: history });
        await column.screenshot({
          path: new URL(`git-history-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
        await page.locator('[data-side-tab="changes"]').click();
        await expect(page.locator('[data-git-panel]')).toBeVisible();
        await page.waitForTimeout(400);
        await page.locator('section[aria-label="Terminals and changes"]').screenshot({
          path: new URL(`side-changes-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
      });
    });
  }

  test.describe('phone', () => {
    test.use({ theme: 'dark', viewport: { width: 390, height: 844 } });
    test('history and git pages', async ({ page }) => {
      await openRoute(page, '/');
      const project = (await firstProjectRoute(page)).replace(/^#/, '');
      await openRoute(page, `${project}/history`);
      await expect(page.locator('[data-history]').first()).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({
        path: new URL('git-history-390-dark.png', OUT_DIR).pathname,
        animations: 'disabled',
      });
      await openRoute(page, `${project}/git`);
      await expect(page.locator('[data-git-panel]')).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({
        path: new URL('git-panel-390-dark.png', OUT_DIR).pathname,
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

// The `?worst=1` demo board: worst-case names, counts and missing fields at every
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
          await expect(page.locator('[data-pod]')).toHaveCount(7);
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
          await lane.locator('[aria-expanded]:not([data-inspect])').focus();
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

          await page.locator('[data-hud="needs-you"]').click();
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
          const phone = viewport.width < 768;
          // Parallel shots start board sessions in this project too, and the demo's Claude
          // sometimes exits (then relaunches): pick a terminal session that is running.
          await runningTerminalSession(page, phone).click({ timeout: 40_000 });
          // Typing into the terminal, or (mid-request) the approval in its place.
          await expect(
            page
              .locator('[data-session-panel] form[data-composer], [data-terminal-approval]')
              .first(),
          ).toBeVisible();
          await page.waitForTimeout(600);
          await shot('composer-terminal');

          await newSession(page, phone);
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
          const phone = viewport.width < 768;
          await runningTerminalSession(page, phone).click({ timeout: 40_000 });
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
            .locator('a[href^="#/p/"]:not([data-needs-you] a)', { hasText: 'docs-site' })
            .first()
            .getAttribute('href');
          await openRoute(page, (href ?? '#/').slice(1));
          const phone = viewport.width < 768;
          const row = sessionLinks(page, phone).filter({ hasText: 'Interrupted' });
          if (!phone) {
            await page.waitForTimeout(400);
            await page.screenshot({
              path: new URL(`session-interrupted-row-${viewport.width}-${theme}.png`, OUT_DIR)
                .pathname,
              animations: 'disabled',
            });
          }
          await row.click();
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
      await page.addInitScript((value) => localStorage.setItem('yardmaster.motion', value), level);
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
      localStorage.setItem('yardmaster.theme', 'light');
      localStorage.setItem('yardmaster.motion', 'full');
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
        localStorage.setItem('yardmaster.ambient', value);
        localStorage.setItem('yardmaster.motion', 'full');
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

// A terminal running claude: its tab, its chat (beside, or its page on phones), the raw
// TUI, and the new-terminal popover (the + New sheet on phones).
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
          if (viewport.width < 768) {
            // Phones: the Claude terminal is one card on the hub; its page toggles chat and TUI.
            const card = page.locator('[data-hub] [data-hub-kind="session"][data-hub-terminal]');
            await expect(card.first()).toBeVisible({ timeout: 30_000 });
            await card.first().click();
            const item = page.locator('[data-workspace-page="item"]');
            await expect(item.locator('[data-session-panel]')).toBeVisible();
            await page.waitForTimeout(1200);
            await shot('claude-terminal');
            await item.locator('[data-item-view] [data-view="raw"]').click();
            await page.waitForTimeout(800);
            await shot('claude-terminal-raw');
            await item.locator('[data-item-view] [data-view="chat"]').click();
            await item.locator('[data-workspace-back]').click();
            await page.locator('[data-hub-new]').click();
            await expect(page.locator('[data-new-sheet]')).toBeVisible();
            await page.waitForTimeout(600);
            await shot('new-terminal');
            return;
          }
          const stack = page.locator('[data-terminal-stack]');
          const tab = stack.locator('[data-claude-tab]').first();
          await expect(tab).toBeVisible({ timeout: 30_000 });
          const sessionId = await tab.getAttribute('data-claude-tab');
          // The Claude column on a new session's composer, so the stack shows the chat itself.
          await page.locator('[data-new-session]').click();
          await tab.click();
          await expect(
            stack.locator(`[data-pane] [data-session-panel="${sessionId}"]`),
          ).toBeVisible();
          await page.mouse.move(viewport.width / 2, viewport.height - 4);
          await page.waitForTimeout(1200);
          await shot('claude-terminal');

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

// Background work: the pod row's line, the focus view's row, and the Claude panel's list.
test.describe('background work', () => {
  for (const theme of THEMES) {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      test.describe(`${theme} ${viewport.width}`, () => {
        test.use({ theme, viewport });
        test('background', async ({ page }) => {
          test.setTimeout(90_000);
          const shot = (name: string) =>
            page.screenshot({
              path: new URL(`${name}-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
              animations: 'disabled',
            });
          const narrow = viewport.width < 768;
          await openRoute(page, '/');
          const pod = page.locator('[data-pod]', { hasText: 'acme-shop' });
          const line = pod.locator('[data-background-line]');
          await expect(line).toBeVisible({ timeout: 30_000 });
          await pod.scrollIntoViewIfNeeded();
          await page.mouse.move(viewport.width / 2, viewport.height - 4);
          await page.waitForTimeout(600);
          if (narrow)
            await pod.screenshot({
              path: new URL(`background-pod-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
              animations: 'disabled',
            });
          else await shot('background-overview');

          await line.click();
          const list = page.locator('[data-background-list]');
          await expect(list).toBeVisible({ timeout: 15_000 });
          // Wait for a finished run, so the shot has both states.
          await expect(
            list.locator('[data-background-item]:not([data-status="running"])').first(),
          ).toBeVisible({ timeout: 30_000 });
          await expect(
            list.locator('[data-background-item][data-status="running"]').first(),
          ).toBeVisible({
            timeout: 30_000,
          });
          await page.mouse.move(viewport.width / 2, viewport.height - 4);
          await page.waitForTimeout(800);
          await shot('background-focus');
          if (narrow) {
            // Back on the project hub.
            await page.locator('[data-workspace-page] [data-workspace-back]').click();
            await expect(page.locator('[data-hub]')).toBeVisible();
            await page.waitForTimeout(600);
            await shot('background-sessions');
          }
        });
      });
    }
  }
});

// The Actor inspector on Minimal (popover, and the bottom sheet on a phone); the
// Office building; its room view.
test.describe('layouts', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme });

      test('inspector', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openRoute(page, '/');
        await page
          .locator('[data-lane][data-terminal-name="next dev"] [data-inspect]')
          .first()
          .click();
        await expect(page.locator('[data-actor-inspector] [data-actor]')).toBeVisible();
        await page.waitForTimeout(600);
        await page.screenshot({
          path: new URL(`inspector-terminal-${theme}.png`, OUT_DIR).pathname,
        });
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-actor-inspector]')).toHaveCount(0);
        await page.locator('[data-session] [data-inspect]').first().click();
        await expect(page.locator('[data-actor-inspector] [data-actor]')).toBeVisible();
        await page.waitForTimeout(600);
        await page.screenshot({
          path: new URL(`inspector-session-${theme}.png`, OUT_DIR).pathname,
        });
      });

      test('inspector sheet', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openRoute(page, '/');
        await page
          .locator('[data-lane][data-terminal-name="next dev"] [data-inspect]')
          .first()
          .click();
        await expect(page.locator('[data-actor-inspector][data-sheet]')).toBeVisible();
        await page.waitForTimeout(800);
        await page.screenshot({
          path: new URL(`inspector-sheet-390-${theme}.png`, OUT_DIR).pathname,
        });
      });

      // The Office building (DESIGN.md §10.3): at rest (just loaded) and under demo activity.
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
        { width: 390, height: 844 },
      ]) {
        test(`office ${viewport.width}`, async ({ page }) => {
          test.slow();
          await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'office'));
          await page.setViewportSize(viewport);
          await openRoute(page, '/');
          await expect(page.locator('[data-room]').first()).toBeVisible();
          await page.waitForTimeout(800);
          const shot = (moment: string) =>
            page.screenshot({
              path: new URL(`layout-office-${moment}-${viewport.width}-${theme}.png`, OUT_DIR)
                .pathname,
              fullPage: true,
              animations: 'disabled',
            });
          await shot('rest');
          // The demo's first permission request arrives 8–14 s in.
          await expect(page.locator('[data-room][data-tone="wait"]').first()).toBeVisible({
            timeout: 30_000,
          });
          await page.waitForTimeout(600);
          await shot('active');
        });
      }

      // The room view, mid-zoom and settled, with the actor panel (a sheet on a phone).
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        test(`office room ${viewport.width}`, async ({ page }) => {
          await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'office'));
          await page.setViewportSize(viewport);
          await openRoute(page, '/');
          const room = page
            .locator('[data-room]', { has: page.locator('[data-scene-actor^="t:"]') })
            .first();
          await expect(room).toBeVisible();
          await page.waitForTimeout(600);
          const shot = (moment: string) =>
            page.screenshot({
              path: new URL(`layout-office-room-${moment}-${viewport.width}-${theme}.png`, OUT_DIR)
                .pathname,
            });
          await room.click({ position: { x: 40, y: 4 } });
          await page.waitForTimeout(80);
          await shot('zooming');
          await expect(page.locator('[data-office]')).not.toHaveAttribute('data-office-moving', '');
          await page.waitForTimeout(400);
          await shot('rest');
        });
      }

      // The Grid's 2D map (a trunk on a phone), at rest and under demo activity, and the
      // flat cockpit of a node. Without WebGL, so the wide views show the map, not the 3D network.
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
        { width: 390, height: 844 },
      ]) {
        test(`grid ${viewport.width}`, async ({ page }) => {
          test.slow();
          await disableWebgl(page);
          await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'grid'));
          await page.setViewportSize(viewport);
          await openRoute(page, '/');
          await expect(page.locator('[data-grid-node]').first()).toBeVisible();
          await page.waitForTimeout(800);
          const shot = (moment: string) =>
            page.screenshot({
              path: new URL(`layout-grid-${moment}-${viewport.width}-${theme}.png`, OUT_DIR)
                .pathname,
              fullPage: true,
            });
          await shot('rest');
          await expect(page.locator('[data-grid-node][data-tone="wait"]').first()).toBeVisible({
            timeout: 30_000,
          });
          await page.waitForTimeout(600);
          await shot('active');
          const node = page
            .locator('[data-grid-node]', { has: page.locator('[data-scene-actor^="t:"]') })
            .first();
          await node.click({ position: { x: 60, y: 8 } });
          await expect(page.locator('[data-grid-cockpit]')).toBeVisible();
          await page.waitForTimeout(900);
          await shot('cockpit');
        });
      }

      // The Grid's 3D network, at rest and under demo activity, and with a node hovered.
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
      ]) {
        test(`grid 3d ${viewport.width}`, async ({ page }) => {
          test.slow();
          await page.addInitScript(() => {
            localStorage.setItem('yardmaster.layout', 'grid');
            localStorage.setItem('yardmaster.motion', 'full');
          });
          await page.setViewportSize(viewport);
          await openRoute(page, '/');
          await expect(page.locator('[data-grid-3d][data-ready]')).toBeVisible();
          await page.waitForTimeout(1500);
          const shot = (moment: string) =>
            page.screenshot({
              path: new URL(`layout-grid3d-${moment}-${viewport.width}-${theme}.png`, OUT_DIR)
                .pathname,
            });
          await shot('rest');
          await expect(page.locator('[data-grid-node][data-tone="wait"]').first()).toBeVisible({
            timeout: 30_000,
          });
          await page.waitForTimeout(1200);
          await shot('active');
          await page
            .locator('[data-grid-node]')
            .first()
            .hover({ position: { x: 100, y: 10 } });
          await page.waitForTimeout(500);
          await shot('hover');

          // The dive into a node with a terminal, mid-flight and at the cockpit, then a
          // terminal screen brought to the center.
          const nodeId = await page
            .locator('[data-grid-label] [data-grid-node]', {
              has: page.locator('[data-scene-actor^="t:"]'),
            })
            .first()
            .getAttribute('data-grid-node');
          await page.locator(`[data-grid-node="${nodeId}"]`).focus();
          await page.keyboard.press('Enter');
          await page.waitForTimeout(450);
          await shot('dive');
          const cockpit = page.locator(`[data-grid-cockpit="${nodeId}"]`);
          await expect(cockpit).toBeVisible();
          await page.waitForTimeout(120);
          await shot('phase');
          await page.waitForTimeout(900);
          await shot('cockpit');
          await cockpit.locator('[data-grid-screen="terminal"] [data-screen-face]').first().click();
          await expect(page.locator('[data-grid-center] [data-xterm]')).toBeVisible();
          await page.waitForTimeout(800);
          await shot('center');
        });
      }

      // The Transit concourse (the departures board beside the line map; on a phone the
      // board above the station lists), at rest and under demo activity, plus a service-log
      // bin's hover card, a board row lighting its station, and a station's inspector.
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
        { width: 390, height: 844 },
      ]) {
        test(`transit ${viewport.width}`, async ({ page }) => {
          test.slow();
          await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'transit'));
          await page.setViewportSize(viewport);
          await openRoute(page, '/');
          await expect(page.locator('[data-transit-line]').first()).toBeVisible();
          await page.waitForTimeout(800);
          const shot = (moment: string, fullPage = true) =>
            page.screenshot({
              path: new URL(`layout-transit-${moment}-${viewport.width}-${theme}.png`, OUT_DIR)
                .pathname,
              fullPage,
              animations: 'disabled',
            });
          await shot('rest');
          await expect(page.locator('[data-transit-line][data-tone="wait"]').first()).toBeVisible({
            timeout: 30_000,
          });
          await page.waitForTimeout(600);
          await shot('active');
          if (viewport.width < 768) {
            await page.locator('[data-transit-line] [data-transit-station]').first().click();
            await expect(page.locator('[data-actor-inspector][data-sheet]')).toBeVisible();
            await page.waitForTimeout(600);
            await shot('inspector', false);
            return;
          }
          await page.locator('[data-transit-event][data-count="1"]').first().hover();
          await expect(page.locator('[data-transit-tip]')).toBeVisible();
          await shot('log', false);
          await page.locator('[data-board-row]').first().hover();
          await expect(page.locator('[data-transit-station][data-lit]')).toHaveCount(1);
          await shot('lit', false);
          await page.mouse.move(4, 4);
          await page.locator('[data-transit-line] [data-transit-station]').first().click();
          await expect(page.locator('[data-actor-inspector] [data-actor]')).toBeVisible();
          await page.waitForTimeout(600);
          await shot('inspector', false);
        });
      }

      // The Retro console at rest and under demo activity, a frame focused by its number,
      // and an actor's inspector.
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
        { width: 390, height: 844 },
      ]) {
        test(`retro ${viewport.width}`, async ({ page }) => {
          test.slow();
          await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'retro'));
          await page.setViewportSize(viewport);
          await openRoute(page, '/');
          await expect(page.locator('[data-retro-frame]').first()).toBeVisible();
          await page.waitForTimeout(800);
          const shot = (moment: string) =>
            page.screenshot({
              path: new URL(`layout-retro-${moment}-${viewport.width}-${theme}.png`, OUT_DIR)
                .pathname,
              fullPage: true,
              animations: 'disabled',
            });
          await shot('rest');
          await expect(page.locator('[data-retro-frame][data-tone="wait"]').first()).toBeVisible({
            timeout: 30_000,
          });
          await page.waitForTimeout(600);
          await shot('active');
          if (viewport.width < 768) return;
          await page.locator('[data-retro]').focus();
          await page.keyboard.press('2');
          await page.keyboard.press('1');
          await shot('focus');
          await page.keyboard.press('Enter');
          await expect(page.locator('[data-actor-inspector] [data-actor]')).toBeVisible();
          await page.waitForTimeout(600);
          await shot('inspector');
        });
      }

      // 20 projects (`--demo-stress --demo-projects 20`) on one screen, and on a phone.
      test('retro stress', async ({ browser }) => {
        test.slow();
        const board = await startBoard({ demo: true, stress: true, projects: 20 });
        try {
          for (const viewport of [
            { width: 1440, height: 900 },
            { width: 390, height: 844 },
          ]) {
            const context = await browser.newContext({
              viewport,
              colorScheme: theme,
              baseURL: board.url,
              storageState: signedInState(board.url, board.session),
            });
            const page = await context.newPage();
            await page.addInitScript((t) => {
              localStorage.setItem('yardmaster.layout', 'retro');
              localStorage.setItem('yardmaster.theme', t);
            }, theme);
            await openRoute(page, '/');
            await expect(page.locator('[data-retro-frame]')).toHaveCount(20);
            await page.waitForTimeout(2500);
            await page.screenshot({
              path: new URL(`layout-retro-stress-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
              fullPage: viewport.width < 768,
              animations: 'disabled',
            });
            await context.close();
          }
        } finally {
          await board.stop();
        }
      });
    });
  }
});

// Every layout on the worst-case board (long names, a fleet of 231 actors, an empty
// project, one with only errors, non-Latin and emoji names), with its enter view, and with 20
// projects (`--demo-stress --demo-projects 20`). For the DESIGN.md §10.7 review.
const LAYOUT_OVERVIEWS = {
  office: '[data-room]',
  grid: '[data-grid-node]',
  transit: '[data-transit-line]',
  retro: '[data-retro-frame]',
} as const;

test.describe('layouts worst case', () => {
  test.describe.configure({ mode: 'serial' });
  for (const [layout, item] of Object.entries(LAYOUT_OVERVIEWS)) {
    for (const [theme, viewport] of [
      ['dark', { width: 1440, height: 900 }],
      ['light', { width: 1440, height: 900 }],
      ['dark', { width: 390, height: 844 }],
    ] as const) {
      test.describe(`${layout} ${theme} ${viewport.width}`, () => {
        test.use({ theme, viewport });
        test('overview and enter view', async ({ page }) => {
          test.slow();
          if (layout === 'grid') await disableWebgl(page);
          await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), layout);
          await page.goto('/?worst=1#/');
          await expect(page.locator(item)).toHaveCount(7);
          await page.waitForTimeout(1200);
          const shot = (moment: string, fullPage = true) =>
            page.screenshot({
              path: new URL(
                `layout-worst-${layout}-${moment}-${viewport.width}-${theme}.png`,
                OUT_DIR,
              ).pathname,
              fullPage,
              animations: 'disabled',
            });
          await shot('overview');
          if (layout === 'office') {
            await page
              .locator('[data-room]')
              .first()
              .click({ position: { x: 40, y: 4 } });
            await expect(page.locator('[data-room-entered]')).toBeVisible();
            await expect(page.locator('[data-office]')).not.toHaveAttribute(
              'data-office-moving',
              '',
            );
            await page.waitForTimeout(500);
            await shot('enter', false);
          }
          if (layout === 'grid') {
            await page
              .locator('[data-grid-node]')
              .first()
              .click({ position: { x: 60, y: 8 } });
            await expect(page.locator('[data-grid-cockpit]')).toBeVisible();
            await page.waitForTimeout(900);
            await shot('enter', false);
            if (viewport.width >= 720) {
              // One screen beside the middle one shows as a centered pair, not an arc
              // with an empty side.
              await page.keyboard.press('Escape');
              await expect(page.locator('[data-grid-cockpit]')).toHaveCount(0);
              await page.locator('[data-grid-node]', { hasText: '💻 portfolio' }).focus();
              await page.keyboard.press('Enter');
              await expect(page.locator('[data-cockpit-row="pair"]')).toBeVisible();
              await page.waitForTimeout(900);
              await shot('pair', false);
            }
          }
        });
      });
    }
  }
});

test.describe('layouts stress', () => {
  test('20 projects', async ({ browser }) => {
    test.slow();
    const board = await startBoard({ demo: true, stress: true, projects: 20 });
    try {
      for (const layout of ['office', 'grid', 'transit'] as const) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          colorScheme: 'dark',
          baseURL: board.url,
          storageState: signedInState(board.url, board.session),
        });
        const page = await context.newPage();
        await page.addInitScript((l) => {
          localStorage.setItem('yardmaster.layout', l);
          localStorage.setItem('yardmaster.theme', 'dark');
          localStorage.setItem('yardmaster.motion', 'full');
        }, layout);
        await openRoute(page, '/');
        await expect(page.locator(LAYOUT_OVERVIEWS[layout])).not.toHaveCount(0);
        await page.waitForTimeout(2500);
        await page.screenshot({
          path: new URL(`layout-stress-${layout}-1440-dark.png`, OUT_DIR).pathname,
          fullPage: layout !== 'grid',
          animations: 'disabled',
        });
        await context.close();
      }
    } finally {
      await board.stop();
    }
  });
});

test.describe('retro amber', () => {
  for (const theme of THEMES) {
    test(theme, async ({ page }) => {
      await page.addInitScript((t) => {
        localStorage.setItem('yardmaster.layout', 'retro');
        localStorage.setItem('yardmaster.phosphor', 'amber');
        localStorage.setItem('yardmaster.theme', t);
      }, theme);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openRoute(page, '/');
      await expect(page.locator('[data-retro][data-phosphor="amber"]')).toBeVisible();
      await page.waitForTimeout(800);
      await page.screenshot({
        path: new URL(`layout-retro-amber-1440-${theme}.png`, OUT_DIR).pathname,
        animations: 'disabled',
      });
    });
  }
});

// A long Retro conversation in every phosphor, at 390 and 1440 in both themes: turn
// headers, your lines brighter than Claude's, tool calls dim and indented, code in a box.
const PHOSPHORS = ['green', 'amber', 'red', 'purple', 'cyan', 'white'] as const;
test.describe('retro conversation', () => {
  for (const phosphor of PHOSPHORS) {
    for (const theme of THEMES) {
      for (const width of [1440, 390]) {
        test.describe(`${phosphor} ${theme} ${width}`, () => {
          test.use({
            theme,
            layout: 'retro',
            viewport: { width, height: width < 768 ? 844 : 900 },
          });
          test('chat', async ({ page }) => {
            await page.addInitScript(
              (p) => localStorage.setItem('yardmaster.phosphor', p),
              phosphor,
            );
            const list = await openLongTranscript(page);
            await expect(page.locator(`[data-focus][data-phosphor="${phosphor}"]`)).toBeVisible();
            await scrollToTurnHead(list);
            await page.waitForTimeout(600);
            await page.screenshot({
              path: new URL(`retro-chat-${phosphor}-${width}-${theme}.png`, OUT_DIR).pathname,
              animations: 'disabled',
            });
          });
        });
      }
    }
  }
});

test.describe('grid reduced', () => {
  test('map', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('yardmaster.layout', 'grid');
      localStorage.setItem('yardmaster.motion', 'reduced');
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRoute(page, '/');
    await expect(page.locator('[data-grid-node]').first()).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({
      path: new URL('layout-grid-reduced-1440-dark.png', OUT_DIR).pathname,
      fullPage: true,
    });
  });
});

// Settings → Projects: two library roots, one readable and one blocked by macOS privacy
// settings. Both routes are faked for this page only; the shared demo board keeps its one root.
for (const theme of THEMES) {
  for (const width of [1440, 390]) {
    test.describe(`settings projects ${theme} ${width}`, () => {
      test.use({ theme, viewport: { width, height: width < 1024 ? 844 : 900 } });

      test('library roots', async ({ page }) => {
        const roots = ['~/Desktop', '/home/dev/archive'];
        await page.route('**/api/settings', async (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          const response = await route.fetch();
          await route.fulfill({
            response,
            json: { ...(await response.json()), libraryRoots: roots },
          });
        });
        await page.route('**/api/library', (route) =>
          route.fulfill({
            json: {
              roots: [
                { root: roots[0], count: 14, error: null, message: null },
                {
                  root: roots[1],
                  count: 0,
                  error: 'permission',
                  message:
                    'macOS blocks access to this folder. Allow it under System Settings → Privacy & Security → Files and Folders, then reload.',
                },
              ],
              entries: [],
            },
          }),
        );
        await openRoute(page, '/settings');
        const section = page.getByRole('region', { name: 'Projects' });
        await expect(section.locator('[data-library-status="permission"]')).toBeVisible();
        await section.scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        await section.screenshot({
          path: new URL(`settings-projects-${width}-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
      });
    });
  }
}

// Open project: the picker over the demo's synthetic library, and the launch sheet with
// all three options ticked. Nothing is launched, so the shared board doesn't change.
for (const theme of THEMES) {
  for (const width of [1440, 390]) {
    test.describe(`open project ${theme} ${width}`, () => {
      test.use({ theme, viewport: { width, height: width < 1024 ? 844 : 900 } });

      test('picker and launch sheet', async ({ page }) => {
        // Phones open it from the Projects tab (DESIGN.md §11).
        await openRoute(page, width < 768 ? '/projects' : '/');
        await page.locator('[data-hud="open-project"], [data-phone-open-project]').click();
        const dialog = page.locator('[data-open-project]');
        await expect(dialog.locator('[data-library-entry="weather-bot"]')).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({
          path: new URL(`open-project-${width}-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
        await dialog.locator('[data-library-entry="weather-bot"]').click();
        const sheet = dialog.locator('[data-launch-sheet="weather-bot"]');
        await sheet.locator('[data-launch-option="claude"] label').click();
        await sheet
          .getByRole('textbox', { name: 'What should Claude do?' })
          .fill('Add a 7-day forecast command');
        await sheet.locator('[data-launch-option="terminal"] label').click();
        await sheet.getByRole('textbox', { name: 'Command to run (optional)' }).fill('pnpm dev');
        await page.waitForTimeout(400);
        await page.screenshot({
          path: new URL(`open-project-launch-${width}-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
      });
    });
  }
}

// Board terminals: a folder opened with only a terminal runs it on the board, with the
// origin mark on its tab and the note in place of the command line. Its own board: it adds a project.
test.describe('board terminal', () => {
  for (const theme of THEMES) {
    test(theme, async ({ browser }) => {
      test.slow();
      const board = await startBoard({ demo: true });
      try {
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          const context = await browser.newContext({
            viewport,
            colorScheme: theme,
            baseURL: board.url,
            storageState: signedInState(board.url, board.session),
          });
          const page = await context.newPage();
          await page.addInitScript((t) => localStorage.setItem('yardmaster.theme', t), theme);
          await page.goto(viewport.width < 768 ? '/#/projects' : '/#/');
          await page.locator('[data-hud="open-project"], [data-phone-open-project]').click();
          const dialog = page.locator('[data-open-project]');
          const entry = viewport.width < 768 ? 'tax-notes' : 'recipe-box';
          await dialog.locator(`[data-library-entry="${entry}"]`).click();
          const sheet = dialog.locator(`[data-launch-sheet="${entry}"]`);
          await sheet.locator('[data-launch-option="editor"] label').click();
          await sheet.locator('[data-launch-option="terminal"] label').click();
          await sheet.getByRole('textbox', { name: 'Command to run (optional)' }).fill('pnpm dev');
          await sheet.getByRole('button', { name: 'Open project' }).click();
          await expect(dialog).toHaveCount(0);
          if (viewport.width < 768) {
            // Phones: the board terminal's card on the hub opens its page, with the key bar.
            const card = page.locator('[data-hub] [data-hub-kind="terminal"]').first();
            await expect(card).toBeVisible({ timeout: 10_000 });
            await card.click();
            await expect(page.locator('[data-key-bar]')).toBeVisible();
          } else {
            const stack = page.locator('[data-terminal-stack]');
            await expect(stack.locator('[role="tab"][data-origin="board"]')).toBeVisible({
              timeout: 10_000,
            });
          }
          await page.waitForTimeout(900);
          await page.screenshot({
            path: new URL(`board-terminal-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
          await context.close();
        }
      } finally {
        await board.stop();
      }
    });
  }
});

// The trust card before a board session in the demo's cloned folder, whose Claude settings
// run a hook and pre-approve tools. Its own board: opening the folder adds a project. Cancel leaves
// it untrusted, so every width shows the card.
test.describe('folder trust', () => {
  for (const theme of THEMES) {
    test(theme, async ({ browser }) => {
      test.slow();
      const board = await startBoard({ demo: true });
      try {
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          const phone = viewport.width < 768;
          const context = await browser.newContext({
            viewport,
            colorScheme: theme,
            baseURL: board.url,
            storageState: signedInState(board.url, board.session),
            ...(phone ? { hasTouch: true, isMobile: true } : {}),
          });
          const page = await context.newPage();
          await page.addInitScript((t) => localStorage.setItem('yardmaster.theme', t), theme);
          await page.goto(phone ? '/#/projects' : '/#/');
          await page.locator('[data-hud="open-project"], [data-phone-open-project]').click();
          const dialog = page.locator('[data-open-project]');
          await dialog.locator('[data-library-entry="cloned-tool"]').click();
          const sheet = dialog.locator('[data-launch-sheet="cloned-tool"]');
          await sheet.locator('[data-launch-option="editor"] label').click();
          await sheet.locator('[data-launch-option="claude"] label').click();
          await sheet
            .getByRole('textbox', { name: 'What should Claude do?' })
            .fill('Read the README and set up the dev tools');
          await sheet.getByRole('button', { name: 'Open project' }).click();
          const card = page.getByRole('dialog', { name: 'Trust cloned-tool?' });
          await expect(card).toBeVisible();
          await page.waitForTimeout(700);
          await page.screenshot({
            path: new URL(`folder-trust-${viewport.width}-${theme}.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
          await card.getByRole('button', { name: 'Cancel' }).click();
          await expect(card).toHaveCount(0);
          await context.close();
        }
      } finally {
        await board.stop();
      }
    });
  }
});

// The phone pass on an iPhone profile (touch, 390 px) in Chromium: the overview in every
// layout, the picker and launch sheet, the focus view's tabs and composer, the Attention Center,
// and Settings → Phone with a host, a live pairing code and paired devices (faked for this page).
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
const PHONE_LAYOUTS = ['minimal', 'office', 'grid', 'transit', 'retro'] as const;

for (const theme of THEMES) {
  test.describe(`phone ${theme}`, () => {
    test.use({ ...iPhone, theme });
    const shot = (page: import('@playwright/test').Page, name: string, fullPage = false) =>
      page.screenshot({
        path: new URL(`phone-${name}-${theme}.png`, OUT_DIR).pathname,
        animations: 'disabled',
        fullPage,
      });

    for (const layout of PHONE_LAYOUTS) {
      test(`overview ${layout}`, async ({ page }) => {
        await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), layout);
        await openRoute(page, '/');
        await expect(page.locator('main [data-layout]').first()).toBeVisible();
        await page.waitForTimeout(1_200);
        await shot(page, `overview-${layout}`);
      });
    }

    test('picker and launch sheet', async ({ page }) => {
      await openRoute(page, '/projects');
      await page.locator('[data-phone-open-project]').tap();
      const dialog = page.locator('[data-open-project]');
      await expect(dialog.locator('[data-library-entry="weather-bot"]')).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, 'picker');
      await dialog.locator('[data-library-entry="weather-bot"]').tap();
      const sheet = dialog.locator('[data-launch-sheet="weather-bot"]');
      await sheet.locator('[data-launch-option="claude"] label').tap();
      await sheet.locator('[data-launch-option="terminal"] label').tap();
      await page.waitForTimeout(500);
      await shot(page, 'launch-sheet');
    });

    test('project hub and composer', async ({ page }) => {
      test.slow();
      await openRoute(page, '/');
      await openRoute(page, await firstProjectRoute(page));
      await expect(page.locator('[data-hub]')).toBeVisible();
      await page.waitForTimeout(700);
      await shot(page, 'focus-hub');
      await newSession(page, true);
      const input = page.getByRole('textbox', { name: 'First message for a new session' });
      await input.fill('Tidy up the cart totals and keep the public API the same.');
      await page.waitForTimeout(400);
      await shot(page, 'composer');
    });

    test('attention center', async ({ page }) => {
      test.slow();
      await openRoute(page, '/');
      const waiting = page.locator('[data-hud="needs-you"]');
      await expect(waiting.locator('[data-value]')).not.toHaveAttribute('data-value', '0', {
        timeout: 30_000,
      });
      await waiting.tap();
      await page.waitForTimeout(800);
      await shot(page, 'attention');
    });

    test('settings phone', async ({ page }) => {
      const host = 'dev-mac.tailnet-acme.ts.net';
      const now = Date.now();
      await page.route('**/api/settings', async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), remoteAllowedHosts: [host] },
        });
      });
      await page.route('**/api/remote/devices', (route) =>
        route.fulfill({
          json: {
            devices: [
              {
                id: 'dev-0a1b2c3d4e5f',
                name: 'iPhone · Safari',
                pairedAt: now - 3 * 86_400_000,
                lastSeenAt: now - 120_000,
                current: true,
              },
              {
                id: 'dev-6a7b8c9d0e1f',
                name: 'iPad · Safari',
                pairedAt: now - 20 * 86_400_000,
                lastSeenAt: now - 5 * 86_400_000,
                current: false,
              },
            ],
          },
        }),
      );
      await page.route('**/api/remote/pair', (route) =>
        route.fulfill({
          json: {
            url: `https://${host}/pair?c=Zm9vYmFyLWRlbW8tcGFpcmluZw`,
            host,
            expiresAt: now + 5 * 60_000,
          },
        }),
      );
      await openRoute(page, '/settings');
      const section = page.getByRole('region', { name: 'Phone' });
      await expect(section.locator(`[data-remote-host="${host}"]`)).toBeVisible();
      await section.getByRole('button', { name: 'Show pairing code' }).tap();
      await expect(section.locator('[data-pairing="live"] svg[data-qr]')).toBeVisible();
      await section.locator('[data-pairing]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await shot(page, 'settings');
      await section.locator('[data-setting="devices"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(page, 'settings-devices');
    });
  });
}

// Settings → Phone on the desktop: the QR code next to its countdown.
for (const theme of THEMES) {
  test.describe(`settings phone ${theme} 1440`, () => {
    test.use({ theme, viewport: { width: 1440, height: 900 } });
    test('pairing', async ({ page }) => {
      const host = 'dev-mac.tailnet-acme.ts.net';
      await page.route('**/api/settings', async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), remoteAllowedHosts: [host] },
        });
      });
      await page.route('**/api/remote/devices', (route) =>
        route.fulfill({ json: { devices: [] } }),
      );
      await page.route('**/api/remote/pair', (route) =>
        route.fulfill({
          json: {
            url: `https://${host}/pair?c=Zm9vYmFyLWRlbW8tcGFpcmluZw`,
            host,
            expiresAt: Date.now() + 5 * 60_000,
          },
        }),
      );
      await openRoute(page, '/settings');
      const section = page.getByRole('region', { name: 'Phone' });
      await section.getByRole('button', { name: 'Show pairing code' }).click();
      await expect(section.locator('svg[data-qr]')).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await section.screenshot({
        path: new URL(`settings-phone-1440-${theme}.png`, OUT_DIR).pathname,
        animations: 'disabled',
      });
    });
  });
}

// The phone shell (DESIGN.md §11) at 360, 390 and 412: each tab and the workspace, on an
// Android-like touch profile.
const { defaultBrowserType: _android, ...galaxy } = devices['Galaxy S24'];
const SHELL_TABS = [
  { tab: 'overview', route: '/', ready: '[data-pod]' },
  { tab: 'projects', route: '/projects', ready: '[data-phone-project]' },
  { tab: 'attention', route: '/attention', ready: '[data-attention-page]' },
  { tab: 'pulse', route: '/pulse', ready: '[data-pulse-row]' },
  { tab: 'more', route: '/more', ready: '[data-more="layout"]' },
] as const;

for (const theme of THEMES) {
  for (const width of [360, 390, 412] as const) {
    test.describe(`phone shell ${theme} ${width}`, () => {
      test.use({ ...galaxy, theme, viewport: { width, height: width === 412 ? 915 : 844 } });
      const shot = (page: import('@playwright/test').Page, name: string) =>
        page.screenshot({
          path: new URL(`phone-shell-${name}-${width}-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });

      test('tabs', async ({ page }) => {
        test.slow();
        await openRoute(page, '/');
        for (const { tab, route, ready } of SHELL_TABS) {
          await page.goto(`/#${route}`);
          await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
          await page.waitForTimeout(700);
          await shot(page, tab);
        }
      });

      // The project hub, each kind of item page, the switcher, + New and the pages.
      test('workspace', async ({ page }) => {
        test.slow();
        await disableWebgl(page);
        await openRoute(page, '/projects');
        await page.locator('[data-phone-project]').first().tap();
        const workspace = page.locator('[data-workspace="phone"]');
        const hub = workspace.locator('[data-hub]');
        await expect(hub).toBeVisible();
        await page.waitForTimeout(700);
        await shot(page, 'workspace-hub');

        const item = workspace.locator('[data-workspace-page="item"]');
        const open = async (card: string, name: string) => {
          const target = hub.locator(card).first();
          if ((await target.count()) === 0) return false;
          await target.tap();
          await expect(item.locator('[data-item-header]')).toBeVisible();
          await page.waitForTimeout(900);
          await shot(page, `workspace-${name}`);
          return true;
        };
        const back = async () => {
          await item.locator('[data-workspace-back]').tap();
          await expect(hub).toBeVisible();
        };
        if (await open('[data-hub-kind="session"]:not([data-hub-terminal])', 'chat')) await back();
        if (await open('[data-hub-kind="session"][data-hub-terminal]', 'claude-terminal')) {
          await item.locator('[data-item-view] [data-view="raw"]').tap();
          await page.waitForTimeout(700);
          await shot(page, 'workspace-claude-terminal-raw');
          await item.locator('[data-item-view] [data-view="chat"]').tap();
          await back();
        }
        await open('[data-hub-kind="terminal"]', 'terminal');
        await item.locator('[data-item-switch]').tap();
        await expect(page.locator('[data-switcher-sheet]')).toBeVisible();
        await page.waitForTimeout(600);
        await shot(page, 'workspace-switcher');
        await page.keyboard.press('Escape');
        await back();

        await hub.locator('[data-hub-new]').tap();
        await expect(page.locator('[data-new-sheet]')).toBeVisible();
        await page.waitForTimeout(600);
        await shot(page, 'workspace-new');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-new-sheet]')).toHaveCount(0);

        for (const row of ['git', 'history', 'ports'] as const) {
          await hub.locator(`[data-hub-row="${row}"]`).tap();
          const sub = workspace.locator(`[data-workspace-page="${row}"]`);
          await expect(sub).toBeVisible();
          await page.waitForTimeout(700);
          await shot(page, `workspace-${row}`);
          await sub.locator('[data-workspace-back]').tap();
          await expect(hub).toBeVisible();
        }

        await hub.locator('[data-workspace-menu-trigger]').tap();
        await expect(page.locator('[data-workspace-menu]')).toBeVisible();
        await page.waitForTimeout(600);
        await shot(page, 'workspace-menu');
      });
    });
  }
}

// The worst-case board on phones (long names, branches and commands, the fleet of
// terminals and sessions), for the fit sweep's review: the overview in Minimal, Grid and Retro,
// the tabs, and the longest project's workspace.
const FIT_SIZES = [
  { name: '360', width: 360, height: 780, themes: ['dark'] },
  { name: '390', width: 390, height: 844, themes: THEMES },
  { name: '412', width: 412, height: 915, themes: ['dark'] },
  { name: 'landscape', width: 844, height: 390, themes: ['dark'] },
] as const;

for (const size of FIT_SIZES) {
  for (const theme of size.themes) {
    test.describe(`phone fit worst ${size.name} ${theme}`, () => {
      test.use({ ...galaxy, theme, viewport: { width: size.width, height: size.height } });
      const shot = (page: import('@playwright/test').Page, name: string) =>
        page.screenshot({
          path: new URL(`phone-fit-worst-${name}-${size.name}-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
      const go = async (page: import('@playwright/test').Page, route: string) => {
        await page.goto(`/?worst=1#${route}`);
        await expect(
          page.locator('[data-phone-shell][data-hydrated], a[href^="#/p/"]:visible').first(),
        ).toBeAttached();
      };

      test('screens', async ({ page }) => {
        test.slow();
        await disableWebgl(page);
        for (const [layout, ready] of [
          ['minimal', '[data-pod]'],
          ['grid', '[data-grid-node]'],
          ['retro', '[data-retro-frame]'],
        ] as const) {
          await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), layout);
          await go(page, '/');
          await page.reload();
          await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
          await page.waitForTimeout(900);
          await shot(page, `overview-${layout}`);
        }
        if (size.width < 768) {
          for (const tab of ['projects', 'attention', 'pulse'] as const) {
            await go(page, `/${tab}`);
            await page.waitForTimeout(700);
            await shot(page, tab);
          }
        }
        await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'minimal'));
        await go(page, '/');
        await page.reload();
        const id = await page.locator('[data-pod]').first().getAttribute('data-pod');
        await go(page, `/p/${id}`);
        const focus = page.locator(`[data-focus="${id}"]`);
        await expect(focus).toBeVisible();
        const tabs = focus.getByRole('tablist', { name: 'Focus view panels' });
        if ((await tabs.count()) === 0) {
          await page.waitForTimeout(700);
          await shot(page, 'workspace');
          return;
        }
        for (const tab of ['Sessions', 'Claude', 'Terminals', 'Changes'] as const) {
          await tabs.getByRole('tab', { name: tab, exact: true }).click();
          await page.waitForTimeout(700);
          await shot(page, `workspace-${tab.toLowerCase()}`);
        }
      });
    });
  }
}

// Every layout's phone version inside the phone shell at 360, 390 and 412 in both themes:
// the overview, the Transit's station lists, the Office room and the Grid cockpit with its
// next screen, and the inspector sheet.
for (const theme of THEMES) {
  for (const width of [360, 390, 412] as const) {
    test.describe(`phone layouts ${theme} ${width}`, () => {
      test.use({ ...galaxy, theme, viewport: { width, height: width === 412 ? 915 : 844 } });
      const shot = (page: import('@playwright/test').Page, name: string) =>
        page.screenshot({
          path: new URL(`phone-layout-${name}-${width}-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
      const open = async (page: import('@playwright/test').Page, layout: string, ready: string) => {
        await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), layout);
        await openRoute(page, '/');
        await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(1_200);
      };

      test('minimal', async ({ page }) => {
        await open(page, 'minimal', '[data-pod]');
        await shot(page, 'minimal');
      });

      test('retro', async ({ page }) => {
        await open(page, 'retro', '[data-retro-frame]');
        await shot(page, 'retro');
        await page.locator('main [data-layout] [data-scene-actor]').first().tap();
        await expect(page.locator('[data-actor-inspector][data-sheet]')).toBeVisible();
        await page.waitForTimeout(700);
        await shot(page, 'retro-inspector');
      });

      test('transit', async ({ page }) => {
        await open(page, 'transit', '[data-transit-line]');
        await shot(page, 'transit');
        // Below the board: the lines as station lists.
        await page.locator('[data-transit-line]').first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        await shot(page, 'transit-lines');
      });

      test('office', async ({ page }) => {
        await open(page, 'office', '[data-room]');
        await shot(page, 'office');
        await page
          .locator('[data-room]')
          .first()
          .tap({ position: { x: 60, y: 6 } });
        await expect(page.locator('[data-office]')).toHaveAttribute('data-office-entered', /.+/);
        await page.waitForTimeout(1_000);
        await shot(page, 'office-room');
      });

      test('grid', async ({ page }) => {
        await open(page, 'grid', '[data-grid-node]');
        await shot(page, 'grid');
        await page
          .locator('[data-grid-node]')
          .first()
          .tap({ position: { x: 100, y: 10 } });
        const cockpit = page.locator('[data-grid-cockpit]');
        await expect(cockpit.locator('[data-swipe-pager]')).toBeVisible();
        await page.waitForTimeout(1_000);
        await shot(page, 'grid-cockpit');
        await cockpit.getByRole('button', { name: 'Next screen', exact: true }).tap();
        await expect(cockpit.locator('[data-swipe-position]')).toHaveAttribute(
          'data-swipe-position',
          '1',
        );
        await page.waitForTimeout(700);
        await shot(page, 'grid-cockpit-next');
      });
    });
  }
}

// Settings → Notifications, with two subscribed devices. The headless shell reports
// notifications as blocked, so the page sees them as not asked yet.
for (const theme of THEMES) {
  for (const width of [1440, 390]) {
    test.describe(`settings notifications ${theme} ${width}`, () => {
      test.use({
        theme,
        viewport: { width, height: 900 },
      });
      test('notifications', async ({ page }) => {
        const now = Date.now();
        await page.addInitScript(() =>
          Object.defineProperty(Notification, 'permission', { get: () => 'default' }),
        );
        await page.route('**/api/push', async (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          const response = await route.fetch();
          await route.fulfill({
            response,
            json: {
              ...(await response.json()),
              devices: [
                {
                  id: 'push-0a1b2c3d',
                  name: 'iPhone · Safari',
                  createdAt: now - 2 * 86_400_000,
                  lastSentAt: now - 600_000,
                },
                {
                  id: 'push-4e5f6a7b',
                  name: 'Mac · Chrome',
                  createdAt: now - 9 * 86_400_000,
                  lastSentAt: null,
                },
              ],
            },
          });
        });
        await openRoute(page, '/settings');
        const section = page.getByRole('region', { name: 'Notifications', exact: true });
        await expect(section.locator('[data-push-device]')).toHaveCount(2);
        await section.scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        await section.screenshot({
          path: new URL(`settings-notifications-${width}-${theme}.png`, OUT_DIR).pathname,
          animations: 'disabled',
        });
      });
    });
  }
}

// Each layout's workspace skin (DESIGN.md §10.8, §10.7) at 1440 and 390 in both themes: the
// project at rest with its running terminal, a Claude session streaming, and a waiting approval.
const SKIN_WAITING: Record<FocusLayout, { item: string; id: string }> = {
  minimal: { item: '[data-pod][data-tone="wait"]', id: 'data-pod' },
  office: { item: '[data-room][data-tone="wait"]', id: 'data-room' },
  grid: { item: '[data-grid-node][data-tone="wait"]', id: 'data-grid-node' },
  transit: { item: '[data-transit-line][data-tone="wait"]', id: 'data-transit-line' },
  retro: { item: '[data-retro-frame][data-tone="wait"]', id: 'data-retro-frame' },
};

test.describe('workspace skins', () => {
  for (const layout of FOCUS_LAYOUTS) {
    for (const theme of THEMES) {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        test.describe(`${layout} ${theme} ${viewport.width}`, () => {
          test.use({ theme, viewport, layout });
          test('workspace', async ({ page }) => {
            test.slow();
            const phone = viewport.width < 768;
            const shot = (moment: string) =>
              page.screenshot({
                path: new URL(`skin-${layout}-${moment}-${viewport.width}-${theme}.png`, OUT_DIR)
                  .pathname,
                animations: 'disabled',
              });
            await openRoute(page, '/');
            await openRoute(page, await firstProjectRoute(page));
            const card = page.locator('[data-focus]');
            await expect(card).toHaveAttribute('data-layout', layout);
            await page.waitForTimeout(900);
            await shot('rest');
            if (phone) {
              // The running dev server's own page.
              await page.locator('[data-hub] a[data-hub-kind="terminal"]').first().click();
              await expect(card.locator('[data-xterm]').first()).toBeVisible();
              await page.waitForTimeout(700);
              await shot('terminal');
            }

            await newSession(page, phone);
            const input = page.getByRole('textbox', { name: 'First message for a new session' });
            await input.fill('Tidy up the cart totals and keep the public API the same.');
            await input.press('Enter');
            await expect(page.locator('[data-session-panel] [data-row="tail"]')).toBeVisible({
              timeout: 15_000,
            });
            await page.waitForTimeout(1_200);
            await shot('streaming');

            // A project whose Claude waits for an approval, opened on that session.
            await openRoute(page, '/');
            const waiting = page.locator(SKIN_WAITING[layout].item).first();
            await expect(waiting).toBeVisible({ timeout: 40_000 });
            if (phone) {
              // A chat can wait for an answer instead, which shows neither an approval card nor
              // (below xl) the caption: try the waiting projects until one waits for an approval.
              const approval = page.locator('[data-hub] a[data-hub-wait="approval"]').first();
              await expect
                .poll(
                  async () => {
                    await openRoute(page, '/');
                    const ids = await page
                      .locator(SKIN_WAITING[layout].item)
                      .evaluateAll(
                        (items, attr) => items.map((item) => item.getAttribute(attr)),
                        SKIN_WAITING[layout].id,
                      );
                    for (const id of ids) {
                      await openRoute(page, `/p/${id}`);
                      await expect(
                        page.locator('[data-hub] a[data-hub-item]').first(),
                      ).toBeVisible();
                      if (await approval.isVisible()) return true;
                    }
                    return false;
                  },
                  { timeout: 60_000 },
                )
                .toBe(true);
              await approval.click();
            } else {
              const id = await waiting.getAttribute(SKIN_WAITING[layout].id);
              await openRoute(page, `/p/${id}`);
              await card.locator('a[data-session]:has([data-status="wait"])').first().click();
            }
            await expect(
              card
                .locator('[data-terminal-approval], [data-approval], [data-focus-caption]')
                .first(),
            ).toBeVisible();
            await page.waitForTimeout(800);
            await shot('waiting');
          });
        });
      }
    }
  }
});

// The Yardmaster brand in place: the HUD lockup, Settings → About, the onboarding header
// and the app icon on a phone's home screen, in both themes.
test.describe('brand', () => {
  for (const theme of THEMES) {
    test.describe(theme, () => {
      test.use({ theme });

      test('hud and about', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openRoute(page, '/settings');
        await page.waitForTimeout(600);
        const hud = page.locator('header').first();
        await hud.screenshot({ path: new URL(`brand-hud-${theme}.png`, OUT_DIR).pathname });
        const about = page.locator('section[aria-label="About"]');
        await about.scrollIntoViewIfNeeded();
        await about.screenshot({ path: new URL(`brand-about-${theme}.png`, OUT_DIR).pathname });
      });

      test('onboarding header', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openRoute(page, '/welcome');
        await page.waitForTimeout(900);
        await page
          .locator('[data-onboarding] header')
          .screenshot({ path: new URL(`brand-onboarding-${theme}.png`, OUT_DIR).pathname });
      });

      test('phone home screen', async ({ page, baseURL }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openRoute(page, '/');
        await page.screenshot({
          path: new URL(`brand-phone-topbar-${theme}.png`, OUT_DIR).pathname,
          clip: { x: 0, y: 0, width: 390, height: 120 },
        });
        // A synthetic home screen: the board's icon among plain placeholder apps.
        const dark = theme === 'dark';
        const tile = (label: string, inner: string) =>
          `<div style="display:flex;flex-direction:column;align-items:center;gap:6px"><div style="width:62px;height:62px;border-radius:14px;overflow:hidden">${inner}</div><span style="font:500 12px system-ui;color:#fff;text-shadow:0 1px 2px rgb(0 0 0 / .4)">${label}</span></div>`;
        const plain = (c: string) => `<div style="width:100%;height:100%;background:${c}"></div>`;
        const apps = [
          tile('Notes', plain(dark ? '#3a3a3c' : '#f2c94c')),
          tile('Mail', plain(dark ? '#2c3e66' : '#4a90e2')),
          tile('Yardmaster', `<img src="${baseURL}/apple-touch-icon.png" width="62" height="62">`),
          tile('Music', plain(dark ? '#4a2333' : '#eb5757')),
          tile('Photos', plain(dark ? '#3a3a3c' : '#ffffff')),
          tile('Maps', plain(dark ? '#23463a' : '#6fcf97')),
          tile('Clock', plain(dark ? '#1c1c1e' : '#333333')),
          tile('Files', plain(dark ? '#2c3e66' : '#56ccf2')),
        ].join('');
        const wallpaper = dark
          ? 'linear-gradient(160deg,#1b1f3a 0%,#0b0c14 60%,#1a1024 100%)'
          : 'linear-gradient(160deg,#a8c0ff 0%,#e6d8ff 55%,#ffd9c2 100%)';
        await page.setContent(
          `<body style="margin:0;height:844px;background:${wallpaper}"><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:28px 0;padding:80px 18px">${apps}</div></body>`,
        );
        await page.locator('img').evaluate((el: HTMLImageElement) => el.decode());
        await page.screenshot({
          path: new URL(`brand-homescreen-${theme}.png`, OUT_DIR).pathname,
        });
      });
    });
  }
});

test.describe('focus view around the chat', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
    ] as const) {
      test.describe(`${theme} ${width}`, () => {
        test.use({ theme, viewport: { width, height } });
        test('panels', async ({ page }) => {
          await openRoute(page, '/');
          await openRoute(page, await firstProjectRoute(page));
          const card = page.locator('[data-focus]');
          await expect(card.locator('[data-session-panel]')).toBeVisible();
          const shot = (name: string) =>
            page.screenshot({
              path: new URL(`chat-${name}-${width}-${theme}.png`, OUT_DIR).pathname,
              animations: 'disabled',
            });
          await page.waitForTimeout(900);
          await shot('open');
          const toggle = card.getByRole('radiogroup', { name: 'Transcript detail' });
          await toggle.getByRole('radio', { name: 'summary' }).click();
          await page.waitForTimeout(500);
          await shot('summary');
          await toggle.getByRole('radio', { name: 'verbose' }).click();
          await page.waitForTimeout(500);
          await shot('verbose');
          await toggle.getByRole('radio', { name: 'normal' }).click();
          await card.locator('[data-rail-toggle]').click();
          await card.locator('[data-side-tab="changes"]').click();
          await page.waitForTimeout(700);
          await shot('rail-changes');
          await card.locator('[data-side-panel] [data-panel-toggle]').click();
          await page.waitForTimeout(700);
          await shot('folded');
        });
      });
    }
  }

  for (const layout of ['office', 'grid', 'transit', 'retro'] as const) {
    test.describe(layout, () => {
      test.use({ layout, viewport: { width: 1280, height: 800 } });
      test('panels', async ({ page }) => {
        await openRoute(page, '/');
        await openRoute(page, await firstProjectRoute(page));
        const card = page.locator('[data-focus]');
        await expect(card.locator('[data-session-panel]')).toBeVisible();
        const shot = (name: string) =>
          page.screenshot({
            path: new URL(`chat-${layout}-${name}-1280.png`, OUT_DIR).pathname,
            animations: 'disabled',
          });
        await page.waitForTimeout(900);
        await shot('open');
        await card.locator('[data-side-tab="changes"]').click();
        await page.waitForTimeout(400);
        await shot('changes');
        await card.locator('[data-rail-toggle]').click();
        await card.locator('[data-side-panel] [data-panel-toggle]').click();
        await page.waitForTimeout(800);
        await shot('folded');
      });
    });
  }
});

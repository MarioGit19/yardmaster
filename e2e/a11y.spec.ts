import AxeBuilder from '@axe-core/playwright';
import { devices, type Page } from '@playwright/test';
import { disableWebgl, expect, FOCUS_LAYOUTS, type FocusLayout, test } from './fixtures.js';

// Axe on every route, every layout's overview and its enter view, the inspector, the picker
// and launch sheet, ⌘K, the Attention Center, Settings and the phone screens, in both themes at
// 1440 and 390 (0 serious or critical issues). Motion is Off so contrast is read from settled
// colors. The terminal's own output colors are the program's, so xterm is left out. Each
// layout's workspace skin is scanned in `skins-a11y.spec.ts`.

const { defaultBrowserType: _android, ...galaxy } = devices['Galaxy S24'];

const READY: Record<FocusLayout, string> = {
  minimal: '[data-pod]',
  office: '[data-room]',
  grid: '[data-grid-node]',
  transit: '[data-transit-line]',
  retro: '[data-retro-frame]',
};

const FORMS = [
  { name: 'desktop', phone: false, viewport: { width: 1440, height: 900 } },
  { name: 'phone', phone: true, viewport: { width: 390, height: 844 } },
] as const;

/** Waits for finite animations to end (an entry or a theme fade read mid-way fails contrast). */
async function settle(page: Page) {
  await page.waitForTimeout(400);
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (a) =>
              a.playState !== 'running' ||
              a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
          ),
      undefined,
      { timeout: 5000 },
    )
    .catch(() => {});
}

/** Collects axe's serious and critical violations on the page, one line per node. */
function scanner(page: Page) {
  const found: string[] = [];
  const scan = async (screen: string) => {
    await settle(page);
    const { violations } = await new AxeBuilder({ page })
      .exclude('.xterm')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      // Experimental in axe (off in its default run), and a summary label on a card is by design.
      .disableRules(['label-content-name-mismatch'])
      .analyze();
    for (const v of violations) {
      if (v.impact !== 'serious' && v.impact !== 'critical') continue;
      for (const node of v.nodes) {
        found.push(`${screen}: ${v.id} ${node.target.join(' ')} ${node.failureSummary ?? ''}`);
      }
    }
  };
  return { found, scan };
}

async function prepare(page: Page) {
  await disableWebgl(page);
  await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'off'));
}

async function go(page: Page, route: string) {
  await page.goto(`/#${route}`);
  await expect(
    page.locator('[data-phone-shell][data-hydrated], a[href^="#/p/"]:visible').first(),
  ).toBeAttached();
}

async function dismiss(page: Page, gone: string) {
  await page.keyboard.press('Escape');
  await expect(page.locator(gone)).toHaveCount(0);
}

for (const theme of ['dark', 'light'] as const) {
  for (const form of FORMS) {
    for (const layout of FOCUS_LAYOUTS) {
      test.describe(`a11y ${layout} ${theme} ${form.name} @a11y`, () => {
        test.use({ ...(form.phone ? galaxy : {}), theme, layout, viewport: form.viewport });

        test('axe finds nothing serious on the overview, its enter view and the inspector', async ({
          page,
        }) => {
          test.slow();
          await prepare(page);
          const { found, scan } = scanner(page);
          await go(page, '/');
          await expect(page.locator(READY[layout]).first()).toBeVisible({ timeout: 20_000 });
          await scan('overview');

          const actor =
            layout === 'minimal'
              ? page.locator('[data-session] [data-inspect]:visible').first()
              : page.locator('[data-scene-actor]:visible').first();
          if ((await actor.count()) > 0) {
            await actor.scrollIntoViewIfNeeded();
            await actor.click();
            await expect(page.locator('[data-actor-inspector]')).toBeVisible();
            await scan('inspector');
            await dismiss(page, '[data-actor-inspector]');
          }

          if (layout === 'office') {
            await page
              .locator('[data-room]')
              .first()
              .click({ position: { x: 40, y: 4 } });
            await expect(page.locator('[data-room-entered]')).toBeVisible();
            await scan('office room');
            await dismiss(page, '[data-room-entered]');
          }
          if (layout === 'grid') {
            await page
              .locator('[data-grid-node]')
              .first()
              .click({ position: { x: 100, y: 10 } });
            await expect(page.locator('[data-grid-cockpit]')).toBeVisible();
            await scan('grid cockpit');
            await dismiss(page, '[data-grid-cockpit]');
          }
          expect(found, found.join('\n')).toEqual([]);
        });
      });
    }

    test.describe(`a11y screens ${theme} ${form.name} @a11y`, () => {
      test.use({ ...(form.phone ? galaxy : {}), theme, viewport: form.viewport });

      test('axe finds nothing serious on any route, sheet or dialog', async ({ page }) => {
        test.setTimeout(240_000);
        await prepare(page);
        const { found, scan } = scanner(page);
        const phone = form.phone;

        await go(page, '/');
        await expect(page.locator('[data-pod]').first()).toBeVisible();
        const ids = await page
          .locator('[data-pod]')
          .evaluateAll((pods) => pods.map((p) => p.getAttribute('data-pod') ?? ''));

        // ⌘K.
        if (phone)
          await page.locator('[data-phone-topbar]').getByRole('button', { name: 'Search' }).click();
        else await page.keyboard.press('ControlOrMeta+k');
        await expect(page.locator('[data-palette]')).toBeVisible();
        await scan('palette');
        await dismiss(page, '[data-palette]');

        // The Attention Center.
        if (phone) await go(page, '/attention');
        else await page.locator('[data-hud="needs-you"]').click();
        await expect(page.locator('#attention-title')).toBeVisible();
        await scan('attention');
        if (!phone) await dismiss(page, '#attention-title');

        if (phone) {
          for (const [route, ready] of [
            ['/projects', '[data-phone-project]'],
            ['/pulse', '[data-pulse-row]'],
            ['/more', '[data-more="layout"]'],
          ] as const) {
            await go(page, route);
            await expect(page.locator(ready).first()).toBeVisible();
            await scan(`tab ${route}`);
          }
        }

        await go(page, '/settings');
        await expect(page.getByRole('region', { name: 'Phone' })).toBeAttached();
        await scan('settings');

        await go(page, '/welcome');
        await expect(page.locator('[data-onboarding]')).toBeVisible();
        await scan('welcome');

        // The picker and its launch sheet.
        if (phone) {
          await go(page, '/projects');
          await page.locator('[data-phone-open-project]:visible').first().click();
        } else {
          await go(page, '/');
          await page.locator('[data-rail-open-project], [data-hud="open-project"]').first().click();
        }
        const picker = page.locator('[data-open-project]');
        await expect(picker.locator('[data-library-entry]').first()).toBeVisible();
        await scan('picker');
        await picker.locator('[data-library-entry]').first().click();
        await expect(picker.locator('[data-launch-sheet]')).toBeVisible();
        await scan('launch sheet');
        await page.keyboard.press('Escape');
        if ((await picker.count()) > 0) await dismiss(page, '[data-open-project]');

        // The first projects' workspaces: every phone page, or the desktop's session and terminal.
        for (const id of ids.slice(0, 2)) {
          await go(page, `/p/${id}`);
          const focus = page.locator(`[data-focus="${id}"]`);
          await expect(focus).toBeVisible();
          await scan(`workspace ${id}`);
          const hub = focus.locator('[data-hub]');
          if ((await hub.count()) > 0) {
            const hrefs = await hub
              .locator('[data-hub-item]')
              .evaluateAll((cards) => cards.map((c) => c.getAttribute('href') ?? ''));
            for (const href of hrefs.slice(0, 3)) {
              await go(page, href.replace(/^#/, ''));
              await expect(focus.locator('[data-item-header]')).toBeVisible();
              await scan(`item ${href}`);
            }
            for (const sub of ['git', 'history', 'ports', 'new'] as const) {
              await go(page, `/p/${id}/${sub}`);
              await expect(focus.locator(`[data-workspace-page="${sub}"]`)).toBeVisible();
              await scan(`${sub} page ${id}`);
            }
          } else {
            const links = await page
              .locator(`a[href^="#/p/${id}/"]`)
              .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
            const session = links.find((h) => h.includes('/s/'));
            const terminal = links.find((h) => h.includes('/t/'));
            for (const href of [session, terminal]) {
              if (!href) continue;
              await go(page, href.replace(/^#/, ''));
              await expect(focus).toBeVisible();
              await scan(`route ${href}`);
            }
          }
          const menu = focus.locator('[data-workspace-menu-trigger]:visible');
          if ((await menu.count()) > 0) {
            await menu.click();
            await expect(page.locator('[data-workspace-menu]')).toBeVisible();
            await scan(`workspace menu ${id}`);
            await dismiss(page, '[data-workspace-menu]');
          }
        }
        expect(found, found.join('\n')).toEqual([]);
      });
    });
  }
}

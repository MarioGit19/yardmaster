import AxeBuilder from '@axe-core/playwright';
import { disableWebgl, expect, FOCUS_LAYOUTS, test } from './fixtures.js';

// 12.6k: axe on each layout's workspace skin (DESIGN.md §10.8 "Same meaning": contrast meets
// WCAG AA in both themes), on the demo's first project and on the worst board's longest one.
// The terminal's own output colors are the program's, so xterm is left out. Scroll boxes without
// a Tab stop (diff hunks, code blocks) are PLAN 12.6l.

const PROJECTS = [
  { query: '', name: null },
  { query: '?worst=1', name: 'northwind' },
] as const;

for (const layout of FOCUS_LAYOUTS) {
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1440, 390]) {
      test.describe(`skin a11y ${layout} ${theme} ${width}`, () => {
        test.use({ theme, layout });

        test('axe finds nothing in the workspace', async ({ page }) => {
          test.slow();
          await disableWebgl(page);
          const found: string[] = [];
          for (const project of PROJECTS) {
            // The rail (desktop only) names every project's route.
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.goto(`/${project.query}#/`);
            const links = page.locator('nav a[href^="#/p/"]');
            await expect(links.first()).toBeVisible();
            const link = project.name
              ? links.filter({ hasText: project.name }).first()
              : links.first();
            const href = await link.getAttribute('href');
            if (!href) throw new Error('no project link');
            const id = href.split('/')[2];

            await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
            await page.goto(`/${project.query}${href}`);
            await page.reload();
            await expect(page.locator(`[data-focus="${id}"]`)).toHaveAttribute(
              'data-layout',
              layout,
            );
            await expect(page.locator('[data-focus]')).toHaveCount(1);
            await page.waitForTimeout(1000);
            const { violations } = await new AxeBuilder({ page })
              .include('[data-focus]')
              .exclude('.xterm')
              .withTags(['wcag2a', 'wcag2aa'])
              .disableRules(['scrollable-region-focusable'])
              .analyze();
            for (const v of violations) {
              for (const node of v.nodes) {
                found.push(`${id} ${v.id}: ${node.target.join(' ')} ${node.failureSummary ?? ''}`);
              }
            }
          }
          expect(found, found.join('\n')).toEqual([]);
        });
      });
    }
  }
}

import type { Page } from '@playwright/test';
import { disableWebgl, expect, FOCUS_LAYOUTS, type FocusLayout, test } from './fixtures.js';

// 13.2: the main flows with the keyboard alone (PRD §9: full keyboard navigation, visible
// focus), and the OS's reduced-motion preference honored in every layout (DESIGN.md §3 rule 10:
// Reduced moves nothing but cross-fades).

const PROJECT: Record<FocusLayout, string> = {
  minimal: '[data-pod] header a',
  office: '[data-room]',
  grid: '[data-grid-node]',
  transit: '[data-transit-name]',
  retro: '[data-retro-name]',
};

/**
 * Whether the focused element shows that it has focus: its own style, a pseudo-element's, its
 * parent's or a descendant's (a resize handle lights its grip) differs from the same element
 * unfocused. Returns a description of an element that shows nothing. Runs in the page.
 */
function focusShows(): string | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  const props = ['outline-style', 'outline-color', 'box-shadow', 'background-color', 'color'];
  const read = () =>
    [el, el.parentElement, ...[...el.querySelectorAll('*')].slice(0, 40)]
      .flatMap((node) =>
        node
          ? [null, '::before', '::after'].map((pseudo) => {
              const style = getComputedStyle(node, pseudo);
              return props.map((p) => style.getPropertyValue(p)).join('|');
            })
          : [],
      )
      .join('\n');
  // Read settled styles: a ring that transitions in would still read as its start.
  const still = document.createElement('style');
  still.textContent = '*, ::before, ::after { transition: none !important; }';
  document.head.append(still);
  const focused = read();
  el.blur();
  const blurred = read();
  el.focus({ preventScroll: true });
  still.remove();
  if (focused !== blurred) return null;
  const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${name}"`;
}

/** The focused element, for messages. Runs in the page. */
function describeActive(): string {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return 'nothing';
  const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${name}"`;
}

/**
 * Presses Tab until the focused element matches `selector`, checking that every stop on the way
 * shows its focus. Returns the stops without a visible focus.
 */
async function tabTo(page: Page, selector: string, max = 300): Promise<string[]> {
  const hidden: string[] = [];
  const path: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const unseen = await page.evaluate(focusShows);
    if (unseen) hidden.push(unseen);
    if (await activeMatches(page, selector)) return hidden;
    path.push(await page.evaluate(describeActive));
  }
  throw new Error(`Tab never reached ${selector}; last stops:\n${path.slice(-6).join('\n')}`);
}

const activeMatches = (page: Page, selector: string) =>
  page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector);

const activeInside = (page: Page, selector: string) =>
  page.evaluate((s) => !!document.activeElement?.closest(s), selector);

test.describe('keyboard @a11y', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the main flows by keyboard alone, with focus always visible', async ({ page }) => {
    test.slow();
    await disableWebgl(page);
    await page.goto('/#/');
    await expect(page.locator('[data-pod]').first()).toBeVisible();

    // The first Tab stop skips the chrome.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await activeMatches(page, '#main')).toBe(true);

    // Into a project from its pod, and back: focus returns to the pod's link.
    const hidden = await tabTo(page, PROJECT.minimal);
    const href = await page.evaluate(() => document.activeElement?.getAttribute('href') ?? '');
    const id = href.split('/')[2] ?? '';
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/p/${id}$`));
    const focus = page.locator(`[data-focus="${id}"]`);
    await expect(focus).toBeVisible();
    // Tab walks the whole workspace, then the HUD and rail around it, never the overview under
    // it. A board terminal keeps Tab for the shell; Shift+Tab leaves it (no keyboard trap).
    let stops = 0;
    while (await activeInside(page, '[data-focus]')) {
      if (await activeMatches(page, '[data-input] .xterm-helper-textarea')) {
        await page.keyboard.press('Tab');
        expect(await activeMatches(page, '[data-input] .xterm-helper-textarea')).toBe(true);
        await page.keyboard.press('Shift+Tab');
        expect(await activeMatches(page, '.xterm-helper-textarea')).toBe(false);
        break;
      }
      const unseen = await page.evaluate(focusShows);
      if (unseen) hidden.push(unseen);
      await page.keyboard.press('Tab');
      expect(await activeInside(page, '[data-offstage]'), 'focus went under the workspace').toBe(
        false,
      );
      expect(++stops, 'Tab is trapped in the workspace').toBeLessThan(120);
    }
    expect(stops).toBeGreaterThan(5);
    if (!(await activeInside(page, '[data-focus]'))) await page.keyboard.press('Shift+Tab');
    expect(await activeInside(page, '[data-focus]')).toBe(true);
    // Text fields keep Esc for themselves (the composer interrupts Claude): step back past them.
    for (let i = 0; i < 10 && (await activeMatches(page, 'input, textarea')); i++) {
      await page.keyboard.press('Shift+Tab');
    }
    expect(await activeInside(page, '[data-focus]')).toBe(true);
    // Esc closes the innermost layer first: the focused control's tooltip (WCAG 1.4.13), then
    // the workspace.
    if ((await page.locator('[role="tooltip"]').count()) > 0) {
      await page.keyboard.press('Escape');
      await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
      await expect(focus).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator(`[data-pod="${id}"] header a`)).toBeFocused();

    // ⌘K: find another project by name and open it.
    const other = await page
      .locator('[data-pod]')
      .nth(1)
      .evaluate((pod) => ({
        id: pod.getAttribute('data-pod') ?? '',
        name: pod.querySelector('header a')?.textContent?.trim() ?? '',
      }));
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('[data-palette]')).toBeVisible();
    expect(await activeInside(page, '[data-palette]')).toBe(true);
    await page.keyboard.type(other.name);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/p/${other.id}`));
    await expect(page.locator(`[data-focus="${other.id}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/$/);

    // The Attention Center from the HUD: focus moves in, Esc gives it back to the trigger.
    const waiting = page.locator('[data-hud="waiting"]');
    hidden.push(...(await tabTo(page, '[data-hud="waiting"]')));
    await page.keyboard.press('Enter');
    await expect(page.locator('#attention-title')).toBeVisible();
    expect(await activeInside(page, 'aside[aria-labelledby="attention-title"]')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#attention-title')).toHaveCount(0);
    await expect(waiting).toBeFocused();

    // The picker (⌘O): type, Enter opens the launch sheet, Esc steps back, Esc closes.
    await page.keyboard.press('ControlOrMeta+o');
    const picker = page.locator('[data-open-project]');
    await expect(picker.locator('[data-library-entry]').first()).toBeVisible();
    expect(await activeInside(page, '[data-open-project]')).toBe(true);
    const entry = await picker
      .locator('[data-library-entry]')
      .first()
      .getAttribute('data-library-entry');
    await page.keyboard.type(entry ?? '');
    await page.keyboard.press('Enter');
    const sheet = picker.locator('[data-launch-sheet]');
    await expect(sheet).toBeVisible();
    expect(await activeInside(page, '[data-launch-sheet]')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    // Settings through ⌘K, then the motion setting with the arrows.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('Settings');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/settings$/);
    const motion = page.getByRole('group', { name: 'Motion' });
    await expect(motion).toBeVisible();
    // Theme's buttons come first; Tab on through Motion's to Reduced and press it.
    hidden.push(...(await tabTo(page, 'fieldset button[aria-pressed]')));
    const reduced = motion.getByRole('button', { name: 'Reduced' });
    for (
      let i = 0;
      i < 12 && !(await reduced.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(reduced).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(reduced).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

    expect(hidden, `no visible focus on:\n${hidden.join('\n')}`).toEqual([]);
  });

  for (const layout of FOCUS_LAYOUTS) {
    test.describe(layout, () => {
      test.use({ layout });

      test('Tab reaches a project, Enter opens it, Esc comes back to it', async ({ page }) => {
        test.slow();
        await disableWebgl(page);
        await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'off'));
        await page.goto('/#/');
        await expect(page.locator(PROJECT[layout]).first()).toBeVisible({ timeout: 20_000 });
        const hidden = await tabTo(page, PROJECT[layout]);
        const target = await page.evaluate(
          () =>
            (document.activeElement as HTMLElement | null)
              ?.closest('[data-focus-return]')
              ?.getAttribute('data-focus-return') ??
            document.activeElement?.getAttribute('href')?.split('/')[2] ??
            '',
        );
        expect(target).not.toBe('');
        await page.keyboard.press('Enter');
        // Office and Grid step into the room or cockpit first; its own Open workspace follows.
        if (layout === 'office') {
          const panel = page.locator(`[data-office-room-panel="${target}"]`);
          await expect(panel).toBeVisible();
          hidden.push(
            ...(await tabTo(page, `[data-office-room-panel="${target}"] [data-room-open]`)),
          );
          await page.keyboard.press('Enter');
        } else if (layout === 'grid') {
          await expect(page.locator(`[data-grid-cockpit="${target}"]`)).toBeVisible();
          hidden.push(
            ...(await tabTo(page, `[data-grid-cockpit="${target}"] [data-cockpit-open]`)),
          );
          await page.keyboard.press('Enter');
        }
        await expect(page).toHaveURL(new RegExp(`#/p/${target}`));
        await expect(page.locator(`[data-focus="${target}"]`)).toBeVisible();
        // The workspace's skin shows focus on its own controls too (DESIGN.md §10.8).
        for (let i = 0; i < 40 && (await activeInside(page, '[data-focus]')); i++) {
          if (await activeMatches(page, 'input, textarea')) break;
          const unseen = await page.evaluate(focusShows);
          if (unseen) hidden.push(unseen);
          await page.keyboard.press('Tab');
        }
        // Off the controls (a text field keeps Esc, a tooltip takes the first one): Esc goes back.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-focus]')).toHaveCount(0);
        // Back where the keyboard left: on the project (or the room or cockpit it came through).
        expect(
          await page.evaluate(
            (id) =>
              !!document.activeElement?.closest(
                `[data-focus-return="${id}"], [data-pod="${id}"], [data-room="${id}"], [data-grid-cockpit="${id}"]`,
              ),
            target,
          ),
        ).toBe(true);
        expect(hidden, `no visible focus on:\n${hidden.join('\n')}`).toEqual([]);
      });
    });
  }
});

/** Running animations that move something (a transform that isn't `none`). Runs in the page. */
function moving(): string[] {
  return document
    .getAnimations()
    .filter((animation) => animation.playState === 'running')
    .flatMap((animation) => {
      const effect = animation.effect as KeyframeEffect | null;
      const frames = effect?.getKeyframes() ?? [];
      const moves = frames.some((frame) =>
        ['transform', 'translate', 'rotate', 'scale'].some(
          (property) =>
            property in frame && frame[property] !== 'none' && frame[property] !== undefined,
        ),
      );
      if (!moves) return [];
      const name = (animation as CSSAnimation).animationName || animation.id || 'motion';
      const target = effect?.target as HTMLElement | null;
      return [`${name} on ${target?.tagName.toLowerCase() ?? '?'}.${target?.className ?? ''}`];
    });
}

/** Samples `moving` every 100 ms for `ms`. */
async function sampleMoving(page: Page, ms: number): Promise<string[]> {
  const seen = new Set<string>();
  for (let t = 0; t < ms; t += 100) {
    for (const m of await page.evaluate(moving)) seen.add(m);
    await page.waitForTimeout(100);
  }
  return [...seen];
}

test.describe('reduced motion @a11y', () => {
  // The OS setting, with the app on its default ("System"): no stored motion level.
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

  for (const layout of FOCUS_LAYOUTS) {
    test.describe(layout, () => {
      test.use({ layout });

      test('the OS preference makes it Reduced: nothing moves, only cross-fades', async ({
        page,
      }) => {
        test.slow();
        await disableWebgl(page);
        await page.goto('/#/');
        await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
        await expect(page.locator(PROJECT[layout]).first()).toBeVisible({ timeout: 20_000 });
        const seen = new Set(await sampleMoving(page, 2500));

        // ⌘K opening and closing.
        await page.keyboard.press('ControlOrMeta+k');
        for (const m of await sampleMoving(page, 600)) seen.add(m);
        await page.keyboard.press('Escape');

        // Into a project and back out.
        await page.locator(PROJECT[layout]).first().focus();
        await page.keyboard.press('Enter');
        if (layout === 'office') {
          await page.locator('[data-room-open]:visible').first().click();
        } else if (layout === 'grid') {
          await page.locator('[data-cockpit-open]:visible').first().click();
        }
        await expect(page.locator('[data-focus]')).toBeVisible();
        for (const m of await sampleMoving(page, 1500)) seen.add(m);
        await page.keyboard.press('Escape');
        for (const m of await sampleMoving(page, 800)) seen.add(m);

        expect([...seen], [...seen].join('\n')).toEqual([]);
      });
    });
  }
});

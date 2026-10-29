import { devices, type Page } from '@playwright/test';
import { disableWebgl, expect, test } from './fixtures.js';

// The phone fit guard (DESIGN.md §11, "Fit rules"). Every screen at 360, 390 and 412 px and
// in landscape, in both themes, on the demo board and on the `?worst=1` board. A screen fails when
// the page scrolls sideways, a visible box runs past the viewport outside a horizontal scroller,
// text overflows its box without an ellipsis or a scroller, a tap target is under 44 px, or an
// input's text is under 16 px.

const { defaultBrowserType: _android, ...galaxy } = devices['Galaxy S24'];
const VIEWPORTS = [
  { name: '360', width: 360, height: 780 },
  { name: '390', width: 390, height: 844 },
  { name: '412', width: 412, height: 915 },
  { name: 'landscape', width: 844, height: 390 },
] as const;
const DATA = [
  { name: 'demo', query: '' },
  { name: 'worst', query: '?worst=1' },
] as const;
const LAYOUTS = [
  { id: 'minimal', ready: '[data-pod]' },
  { id: 'office', ready: '[data-room]' },
  { id: 'grid', ready: '[data-grid-node]' },
  { id: 'transit', ready: '[data-transit-line]' },
  { id: 'retro', ready: '[data-retro-frame]' },
] as const;

/** Everything on screen that breaks a fit rule, one line each. Runs in the page. */
function fitProblems(): string[] {
  // The layout viewport: on a phone `innerWidth` follows the visual viewport, which zooms out
  // to show content that spills sideways.
  const W = document.documentElement.clientWidth;
  const H = window.innerHeight;
  const out = new Set<string>();
  const SLACK = 1;
  const nameOf = (el: Element) => {
    const data = [...el.attributes]
      .filter((a) => a.name.startsWith('data-') || a.name === 'aria-label' || a.name === 'role')
      .slice(0, 2)
      .map((a) => (a.value ? `[${a.name}="${a.value.slice(0, 24)}"]` : `[${a.name}]`))
      .join('');
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3) : [];
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
    return `${el.tagName.toLowerCase()}${data}${cls.length ? `.${cls.join('.')}` : ''}${text ? ` "${text}"` : ''}`;
  };
  const clipsX = (el: Element) => getComputedStyle(el).overflowX !== 'visible';
  const scrollsX = (el: Element) => /auto|scroll/.test(getComputedStyle(el).overflowX);
  /** The ancestors that clip or scroll sideways, nearest first. */
  const clippers = (el: Element) => {
    const found: Element[] = [];
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      if (p !== document.body && clipsX(p)) found.push(p);
    }
    return found;
  };
  const inside = (r: DOMRect) => r.right <= W + SLACK && r.left >= -SLACK;
  const skipped = (el: Element) =>
    Boolean(el.closest('.xterm, svg *, canvas, [aria-hidden="true"], [inert]')) ||
    // A visually hidden element (the sr-only pattern).
    el.closest('.sr-only') !== null ||
    // A toast tucked behind the front one (Sonner scales it down): a tap expands the stack first.
    el.closest('[data-sonner-toast][data-front="false"][data-expanded="false"]') !== null;
  const visible = (el: Element) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    el.getClientRects().length > 0;

  const doc = document.documentElement;
  if (doc.scrollWidth > W) out.add(`page scrolls sideways (${doc.scrollWidth} > ${W})`);

  for (const el of document.body.querySelectorAll('*')) {
    if (skipped(el) || !visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    // Parked off screen until it's needed (the skip link).
    if (style.position === 'fixed' && (rect.bottom <= 0 || rect.top >= H)) continue;
    const clips = clippers(el);
    const clip = clips[0] ?? null;
    const clipRect = clip?.getBoundingClientRect();

    // A box past the viewport, not inside a box (on screen) that clips or scrolls it.
    if (!inside(rect) && !clips.some((c) => inside(c.getBoundingClientRect()))) {
      out.add(
        `past the viewport [${Math.round(rect.left)}, ${Math.round(rect.right)}]: ${nameOf(el)}`,
      );
    }

    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
    );
    if (ownText && style.display !== 'inline' && style.display !== 'contents') {
      // Text wider than its box (measured on the text itself, so decorative children don't
      // count): fine with an ellipsis or a line clamp, its own scroller, or spilling into a
      // scroller around it.
      const range = document.createRange();
      let left = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !(node.textContent ?? '').trim()) continue;
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          left = Math.min(left, r.left);
          right = Math.max(right, r.right);
        }
      }
      const box = el.getBoundingClientRect();
      // The padding box: text may sit in the padding, not past it. Boxes can be scaled (the
      // Office building), so layout sizes are taken to screen pixels.
      const scale = (el as HTMLElement).offsetWidth
        ? box.width / (el as HTMLElement).offsetWidth
        : 1;
      const inner = {
        left: box.left + el.clientLeft * scale,
        right: box.left + (el.clientLeft + el.clientWidth) * scale,
      };
      if (right > inner.right + SLACK || left < inner.left - SLACK) {
        const ellipsis =
          (style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none') && clipsX(el);
        const ok = ellipsis || scrollsX(el) || (!clipsX(el) && clip !== null && scrollsX(clip));
        if (!ok) {
          out.add(
            `text overflows (${Math.round(right - left)} > ${el.clientWidth}): ${nameOf(el)}`,
          );
        }
      }
      // Text cut off by a clipping ancestor that doesn't scroll.
      if (clip && clipRect && !scrollsX(clip) && rect.right > clipRect.right + SLACK) {
        const ellipsis = style.textOverflow === 'ellipsis';
        if (!ellipsis) out.add(`text clipped by ${nameOf(clip).slice(0, 40)}: ${nameOf(el)}`);
      }
    }
  }

  // Tap targets: 44 × 44 px, except links inside running text.
  const TARGETS =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]';
  for (const el of document.body.querySelectorAll(TARGETS)) {
    if (skipped(el) || (el as HTMLButtonElement).disabled) continue;
    const target = el.matches('input, textarea, select') ? (el.closest('label') ?? el) : el;
    if (!visible(target)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'inline' && el.parentElement?.closest('p, li')) continue;
    if (style.pointerEvents === 'none') continue;
    const rect = target.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (style.position === 'fixed' && (rect.bottom <= 0 || rect.top >= H)) continue;
    // A hit area grown by an absolutely positioned pseudo-element counts. Its box is laid out
    // in the nearest positioned ancestor (the target itself, usually).
    let width = rect.width;
    let height = rect.height;
    for (const pseudo of ['::before', '::after']) {
      const p = getComputedStyle(target, pseudo);
      if (p.content === 'none' || p.position !== 'absolute') continue;
      const holder =
        getComputedStyle(target).position === 'static'
          ? ((target as HTMLElement).offsetParent ?? document.body)
          : target;
      const box = holder.getBoundingClientRect();
      const px = (v: string) => (v.endsWith('px') ? Number.parseFloat(v) : null);
      const left = px(p.left);
      const right = px(p.right);
      const top = px(p.top);
      const bottom = px(p.bottom);
      if (left !== null && right !== null) width = Math.max(width, box.width - left - right);
      if (top !== null && bottom !== null) height = Math.max(height, box.height - top - bottom);
    }
    if (width < 44 - 0.5 || height < 44 - 0.5) {
      out.add(`tap target ${Math.round(width)} × ${Math.round(height)}: ${nameOf(el)}`);
    }
  }

  for (const el of document.body.querySelectorAll('input, textarea, select')) {
    if (skipped(el) || !visible(el)) continue;
    if (/^(checkbox|radio|range|color|file|hidden)$/.test((el as HTMLInputElement).type)) continue;
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (size < 16) out.add(`input text ${size} px: ${nameOf(el)}`);
  }
  return [...out];
}

test.describe('phone-fit guard', () => {
  test.use({ ...galaxy, viewport: { width: 390, height: 844 } });

  test('catches each kind of misfit', async ({ page }) => {
    await page.setContent(`<!doctype html>
      <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <div style="width: 600px">wide</div>
      <p style="width: 100px; white-space: nowrap; overflow: hidden">a name that is far too long</p>
      <div style="width: 200px; overflow-x: auto"><pre style="margin: 0">a long line of code that scrolls in its own box</pre></div>
      <p style="width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">a long name with an ellipsis</p>
      <button style="width: 30px; height: 30px">x</button>
      <button style="width: 60px; height: 44px">ok</button>
      <input style="font-size: 14px; height: 44px">
    `);
    const found = await page.evaluate(fitProblems);
    expect(found.some((p) => p.startsWith('page scrolls sideways'))).toBe(true);
    expect(found.some((p) => p.startsWith('past the viewport') && p.includes('"wide"'))).toBe(true);
    expect(found.some((p) => p.startsWith('text overflows') && p.includes('far too long'))).toBe(
      true,
    );
    expect(found.some((p) => p.includes('scrolls in its own box'))).toBe(false);
    expect(found.some((p) => p.includes('with an ellipsis'))).toBe(false);
    expect(found.some((p) => p.startsWith('tap target 30 × 30'))).toBe(true);
    expect(found.some((p) => p.includes('"ok"'))).toBe(false);
    expect(found.some((p) => p.startsWith('input text 14 px'))).toBe(true);
  });
});

for (const data of DATA) {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['dark', 'light'] as const) {
      test.describe(`phone-fit ${data.name} ${viewport.name} ${theme}`, () => {
        test.use({
          ...galaxy,
          theme,
          viewport: { width: viewport.width, height: viewport.height },
        });

        test('every screen fits', async ({ page }) => {
          test.setTimeout(420_000);
          await walk(page, data.query, viewport.width < 768);
        });
      });
    }
  }
}

const settle = (page: Page, ms = 450) => page.waitForTimeout(ms);

/** Visits every screen and checks it; collects all problems, then fails once with the list. */
async function walk(page: Page, query: string, phone: boolean) {
  const worst = query !== '';
  const problems: string[] = [];
  const check = async (screen: string) => {
    await settle(page);
    let found = await page.evaluate(fitProblems);
    // A misfit is still there a moment later. A box caught mid-entry or mid-exit (the "Jump to
    // latest" pill scaling in while the demo streams) is not one.
    if (found.length > 0) {
      await settle(page, 400);
      const again = new Set(await page.evaluate(fitProblems));
      found = found.filter((line) => again.has(line));
    }
    for (const line of found) {
      problems.push(`${screen}: ${line}`);
      if (process.env.FIT_DEBUG) console.log(`${screen}: ${line}`);
    }
  };
  const go = async (route: string) => {
    await page.goto(`/${query}#${route}`);
    await expect(
      page.locator('[data-phone-shell][data-hydrated], a[href^="#/p/"]:visible').first(),
    ).toBeAttached();
  };
  const dismiss = async (gone: string) => {
    await page.keyboard.press('Escape');
    await expect(page.locator(gone)).toHaveCount(0);
  };

  // The Grid draws its 2D map here: the fit rules are about the DOM.
  await disableWebgl(page);

  for (const layout of LAYOUTS) {
    await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), layout.id);
    await go('/');
    await page.reload();
    await expect(page.locator(layout.ready).first()).toBeVisible({ timeout: 20_000 });
    await check(`overview ${layout.id}`);

    // The inspector, from the first actor on screen.
    const actor =
      layout.id === 'minimal'
        ? page.locator('[data-session] [data-inspect]:visible').first()
        : page.locator('[data-scene-actor]:visible').first();
    if ((await actor.count()) > 0) {
      await actor.scrollIntoViewIfNeeded();
      await actor.click();
      await expect(page.locator('[data-actor-inspector]')).toBeVisible();
      await check(`inspector ${layout.id}`);
      await dismiss('[data-actor-inspector]');
    }

    if (layout.id === 'office') {
      await page
        .locator('[data-room]')
        .first()
        .click({ position: { x: 40, y: 4 } });
      await expect(page.locator('[data-room-entered]')).toBeVisible();
      await check('enter office');
      await dismiss('[data-room-entered]');
    }
    if (layout.id === 'grid') {
      await page
        .locator('[data-grid-node]')
        .first()
        .click({ position: { x: 100, y: 10 } });
      await expect(page.locator('[data-grid-cockpit]')).toBeVisible();
      await settle(page, 600);
      await check('enter grid');
      await dismiss('[data-grid-cockpit]');
    }
  }
  await page.addInitScript(() => localStorage.setItem('yardmaster.layout', 'minimal'));
  await go('/');
  await page.reload();
  await expect(page.locator('[data-pod]').first()).toBeVisible();

  // ⌘K.
  if (phone)
    await page.locator('[data-phone-topbar]').getByRole('button', { name: 'Search' }).click();
  else await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('[data-palette]')).toBeVisible();
  await check('palette');
  await dismiss('[data-palette]');

  // The Attention Center.
  if (phone) await go('/attention');
  else await page.locator('[data-hud="waiting"]').click();
  await expect(page.locator('#attention-title')).toBeVisible();
  await check('attention');
  if (!phone) await dismiss('#attention-title');

  if (phone) {
    for (const [route, ready] of [
      ['/projects', '[data-phone-project]'],
      ['/pulse', '[data-pulse-row]'],
      ['/more', '[data-more="layout"]'],
    ] as const) {
      await go(route);
      await expect(page.locator(ready).first()).toBeVisible();
      await check(`tab ${route}`);
    }
  }

  await go('/settings');
  await expect(page.getByRole('region', { name: 'Phone' })).toBeAttached();
  await check('settings');

  // The picker and its launch sheet.
  if (phone) {
    await go('/projects');
    await page.locator('[data-phone-open-project]:visible').first().click();
  } else {
    await go('/');
    await page.locator('[data-rail-open-project], [data-hud="open-project"]').first().click();
  }
  const picker = page.locator('[data-open-project]');
  await expect(picker.locator('[data-library-entry]').first()).toBeVisible();
  await check('picker');
  await picker.locator('[data-library-entry]').first().click();
  await expect(picker.locator('[data-launch-sheet]')).toBeVisible();
  await check('launch sheet');
  await page.keyboard.press('Escape');
  if ((await picker.count()) > 0) await dismiss('[data-open-project]');

  // A workspace of every project with sessions, each tab, and its tool cards opened.
  await go('/');
  const ids = await page
    .locator('[data-pod]')
    .evaluateAll((pods) => pods.map((p) => p.getAttribute('data-pod')).filter(Boolean));
  // Every worst-case project (the fleet of terminals and sessions, the longest names); on the
  // demo board the first three, whose chats hold diffs and wide tool output.
  let diffs = 0;
  const openToolCards = async (root: ReturnType<Page['locator']>) => {
    // Open the tool cards in place (a streaming chat re-renders under a pointer click).
    await root.evaluate((el) => {
      const closed = el.querySelectorAll<HTMLButtonElement>(
        '[data-tool-kind] button[aria-expanded="false"]:not([disabled])',
      );
      for (const button of [...closed].slice(0, 12)) button.click();
    });
    return root.locator('[data-diff-view]').count();
  };
  for (const id of worst ? ids : ids.slice(0, 3)) {
    const n = ids.indexOf(id) + 1;
    await go(`/p/${id}`);
    const focus = page.locator(`[data-focus="${id}"]`);
    await expect(focus).toBeVisible();
    const hub = focus.locator('[data-hub]');
    if ((await hub.count()) > 0) {
      // Phones: the project hub, every item's page, the switcher, + New and the pages.
      await check(`hub (${n})`);
      const hrefs = await hub
        .locator('[data-hub-item]')
        .evaluateAll((cards) => cards.map((c) => c.getAttribute('href') ?? ''));
      for (const href of hrefs.slice(0, worst ? 8 : 6)) {
        await go(href.replace(/^#/, ''));
        const item = focus.locator('[data-workspace-page="item"]');
        await expect(item.locator('[data-item-header]')).toBeVisible();
        diffs += await openToolCards(item);
        await check(`item ${href.split('/').slice(-2).join('/')} (${n})`);
        const terminalView = item.locator('[data-item-view] [data-view="raw"]');
        if ((await terminalView.count()) > 0) {
          await terminalView.click();
          await check(`item terminal view (${n})`);
          await item.locator('[data-item-view] [data-view="chat"]').click();
        }
      }
      if (hrefs[0]) {
        await go(hrefs[0].replace(/^#/, ''));
        await focus.locator('[data-item-switch]').click();
        await expect(page.locator('[data-switcher-sheet]')).toBeVisible();
        await check(`switcher (${n})`);
        await dismiss('[data-switcher-sheet]');
      }
      for (const sub of ['git', 'history', 'ports', 'new'] as const) {
        await go(`/p/${id}/${sub}`);
        await expect(focus.locator(`[data-workspace-page="${sub}"]`)).toBeVisible();
        await check(`${sub} page (${n})`);
      }
      await go(`/p/${id}`);
      await hub.locator('[data-hub-new]').click();
      await expect(page.locator('[data-new-sheet]')).toBeVisible();
      await check(`+ New sheet (${n})`);
      await dismiss('[data-new-sheet]');
    } else {
      const tabs = focus.getByRole('tablist', { name: 'Focus view panels' });
      const tabbed = (await tabs.count()) > 0;
      for (const tab of tabbed ? (['Sessions', 'Claude', 'Terminals'] as const) : [null]) {
        if (tab) await tabs.getByRole('tab', { name: tab, exact: true }).click();
        if (tab === 'Claude' || tab === null) diffs += await openToolCards(focus);
        await check(`workspace ${tab ?? 'columns'} (${n})`);
      }
    }
    const menu = focus.locator('[data-workspace-menu-trigger]:visible');
    if ((await menu.count()) > 0) {
      await menu.click();
      await expect(page.locator('[data-workspace-menu]')).toBeVisible();
      await check(`workspace menu (${n})`);
      await dismiss('[data-workspace-menu]');
    }
  }

  // Each layout's workspace skin (DESIGN.md §10.8 "Phones"): the hub, an item page and the
  // switcher of the first projects (on the worst board, the longest names and the fleet).
  for (const layout of LAYOUTS.filter((l) => l.id !== 'minimal')) {
    await page.addInitScript((l) => localStorage.setItem('yardmaster.layout', l), layout.id);
    for (const id of ids.slice(0, worst ? 3 : 1)) {
      const n = `${layout.id} ${ids.indexOf(id) + 1}`;
      await go(`/p/${id}`);
      await page.reload();
      const focus = page.locator(`[data-focus="${id}"][data-layout="${layout.id}"]`);
      await expect(focus).toBeVisible();
      const hub = focus.locator('[data-hub]');
      if ((await hub.count()) === 0) {
        await check(`skin workspace (${n})`);
        continue;
      }
      await check(`skin hub (${n})`);
      const href = await hub.locator('[data-hub-item]').first().getAttribute('href');
      if (!href) continue;
      await go(href.replace(/^#/, ''));
      await expect(focus.locator('[data-item-header]')).toBeVisible();
      await check(`skin item (${n})`);
      await focus.locator('[data-item-switch]').click();
      await expect(page.locator('[data-switcher-sheet]')).toBeVisible();
      await check(`skin switcher (${n})`);
      await dismiss('[data-switcher-sheet]');
    }
  }

  // The phone's chat page shows the chat whole; the landscape columns may virtualize it.
  if (!worst && phone) expect(diffs, 'no diff was opened in a chat').toBeGreaterThan(0);
  expect(problems, problems.join('\n')).toEqual([]);
}

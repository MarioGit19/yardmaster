import type { Page } from '@playwright/test';
import { disableWebgl, expect, FOCUS_LAYOUTS, test } from './fixtures.js';

// Which syntax colors land on a diff tint depends on the code on screen, so a scan of the demo
// only sometimes meets the worst pair. This draws every color on every tint with the app's own
// CSS, wherever a diff appears. Ratios are worked out here, not by axe: a skin's pseudo-element
// overlay makes axe give up on the background and report nothing.

const INKS = [
  '--text-1',
  '--shiki-foreground',
  '--shiki-token-keyword',
  '--shiki-token-string',
  '--shiki-token-string-expression',
  '--shiki-token-function',
  '--shiki-token-constant',
  '--shiki-token-parameter',
  '--shiki-token-punctuation',
  '--shiki-token-comment',
  '--shiki-token-link',
  '--shiki-token-inserted',
  '--shiki-token-deleted',
  '--shiki-token-changed',
];

const AA = 4.5;

/** Every ink on `host`'s tokens, on each kind of row and changed word, under `surfaces`. */
function measure(page: Page, host: string, surfaces: string[]) {
  return page
    .locator(host)
    .first()
    .evaluate(
      (root, { inks, surfaces, aa }) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no canvas');
        // Canvas resolves any CSS color (color-mix, oklch) and composites alpha as the page does.
        const paint = (colors: string[]) => {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, 1, 1);
          for (const color of colors) {
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
          }
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3) as [number, number, number];
        };
        const luminance = (rgb: number[]) => {
          const [r = 0, g = 0, b = 0] = rgb.map((c) => {
            const v = c / 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a: number[], b: number[]) => {
          const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
          return (hi + 0.05) / (lo + 0.05);
        };

        let holder = root;
        for (const surface of surfaces) {
          const box = document.createElement('div');
          box.className = surface;
          holder.append(box);
          holder = box;
        }
        const diff = document.createElement('div');
        diff.className = 'diff';
        holder.append(diff);

        /** The element's background on everything behind it, outermost first. */
        const ground = (el: Element) => {
          const stack: string[] = [];
          for (let at: Element | null = el; at; at = at.parentElement) {
            stack.unshift(getComputedStyle(at).backgroundColor);
          }
          return paint(stack);
        };

        const low: string[] = [];
        let checked = 0;
        const check = (el: Element, label: string) => {
          const bg = ground(el);
          ctx.fillStyle = `rgb(${bg.join(' ')})`;
          const ink = paint([`rgb(${bg.join(' ')})`, getComputedStyle(el).color]);
          const value = ratio(ink, bg);
          checked++;
          if (value < aa) low.push(`${label}: rgb(${ink}) on rgb(${bg}) is ${value.toFixed(2)}`);
        };
        for (const type of ['add', 'del', 'ctx']) {
          const row = document.createElement('div');
          row.className = `diff-row diff-${type}`;
          const no = document.createElement('span');
          no.className = 'diff-no';
          const sign = document.createElement('span');
          sign.className = 'diff-sign';
          row.append(no, sign);
          diff.append(row);
          check(no, `${type} line number`);
          check(sign, `${type} sign`);
          for (const ink of inks) {
            for (const mark of [false, true]) {
              const word = document.createElement('span');
              if (mark) word.className = 'diff-mark';
              word.style.color = `var(${ink})`;
              row.append(word);
              check(word, `${type}${mark ? ' mark' : ''} ${ink}`);
            }
          }
        }
        holder.replaceChildren();
        return { low, checked };
      },
      { inks: INKS, surfaces, aa: AA },
    );
}

async function expectReadable(page: Page, host: string, surfaces: string[]) {
  const { low, checked } = await measure(page, host, surfaces);
  expect(checked).toBe(3 * (2 + INKS.length * 2));
  expect(low, low.join('\n')).toEqual([]);
}

async function prepare(page: Page, phosphor?: string) {
  await disableWebgl(page);
  await page.addInitScript((p) => {
    localStorage.setItem('yardmaster.motion', 'off');
    if (p) localStorage.setItem('yardmaster.phosphor', p);
  }, phosphor);
}

async function openWorkspace(page: Page) {
  await page.goto('/#/');
  const link = page.locator('nav a[href^="#/p/"]').first();
  await expect(link).toBeVisible();
  await page.goto(`/${await link.getAttribute('href')}`);
  await expect(page.locator('[data-focus]')).toBeVisible();
}

const TOOL_CARD = ['tool-card bg-bg-1'];
const APPROVAL = ['bg-bg-1', 'bg-bg-0/60'];

for (const theme of ['dark', 'light'] as const) {
  for (const layout of FOCUS_LAYOUTS) {
    test.describe(`diff contrast ${layout} ${theme} @a11y`, () => {
      test.use({ theme, layout });

      test('every syntax color reads on every tint of a tool card diff', async ({ page }) => {
        await prepare(page);
        await openWorkspace(page);
        await expectReadable(page, '[data-focus]', TOOL_CARD);
      });
    });
  }

  test.describe(`diff contrast retro phosphors ${theme} @a11y`, () => {
    test.use({ theme, layout: 'retro' });

    for (const phosphor of ['amber', 'red', 'purple', 'cyan', 'white']) {
      test(`every syntax color reads on every tint in ${phosphor}`, async ({ page }) => {
        await prepare(page, phosphor);
        await openWorkspace(page);
        await expectReadable(page, '[data-focus]', TOOL_CARD);
      });
    }
  });

  test.describe(`diff contrast approvals ${theme} @a11y`, () => {
    test.use({ theme });

    test('every syntax color reads on every tint of an approval diff', async ({ page }) => {
      await prepare(page);
      await page.goto('/#/');
      await expect(page.locator('[data-hud="needs-you"]')).toBeVisible();
      await expectReadable(page, 'body', APPROVAL);
    });
  });
}

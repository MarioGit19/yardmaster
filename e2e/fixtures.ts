import { test as base, expect, type Page } from '@playwright/test';
import { E2E_COOKIE, E2E_URL } from './env.js';

export type Theme = 'dark' | 'light';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is unset; run through the e2e Playwright config`);
  return value;
}

/** The layouts whose workspace skin the focus specs run in (DESIGN.md §10.8); later skins join. */
export const FOCUS_LAYOUTS = ['minimal', 'office', 'grid', 'transit', 'retro'] as const;
export type FocusLayout = (typeof FOCUS_LAYOUTS)[number];

/** Tests get a page that is already signed in to the demo board. */
export const test = base.extend<{ theme: Theme; layout: FocusLayout }>({
  theme: ['dark', { option: true }],
  // Minimal is the app's default: only another layout is stored, so specs that set their own keep it.
  layout: ['minimal', { option: true }],
  baseURL: async ({}, use) => use(required(E2E_URL)),
  colorScheme: async ({ theme }, use) => use(theme),
  storageState: async ({}, use) => use(signedInState(required(E2E_URL), required(E2E_COOKIE))),
  page: async ({ page, theme, layout }, use) => {
    await page.addInitScript((value) => localStorage.setItem('yardmaster.theme', value), theme);
    if (layout !== 'minimal') {
      await page.addInitScript((value) => localStorage.setItem('yardmaster.layout', value), layout);
    }
    await use(page);
  },
});

export { expect };

/** Browser storage holding the board's session cookie (`name=value`) for `origin`. */
export function signedInState(origin: string, cookie: string) {
  const url = new URL(origin);
  const [name = '', value = ''] = cookie.split(/=(.*)/s);
  return {
    cookies: [
      {
        name,
        value,
        domain: url.hostname,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Strict' as const,
      },
    ],
    origins: [],
  };
}

/**
 * Opens a hash route and waits until the demo snapshot has rendered the project rail (on a phone,
 * which has no rail: until the phone shell has the snapshot).
 */
export async function openRoute(page: Page, route: string): Promise<void> {
  await page.goto(`/#${route}`);
  await expect(
    page.locator('a[href^="#/p/"]:visible, [data-phone-shell][data-hydrated]').first(),
  ).toBeAttached();
}

/**
 * The route of the first demo project, read from the rail (on a phone, from the overview's links,
 * or the Grid trunk's nodes and the Office's rooms, which aren't links).
 */
export async function firstProjectRoute(page: Page): Promise<string> {
  const first = page.locator('a[href^="#/p/"], [data-grid-node], [data-room]').first();
  await first.waitFor({ state: 'attached' });
  const href = await first.getAttribute('href');
  if (href) return href.slice(1);
  const node =
    (await first.getAttribute('data-grid-node')) ?? (await first.getAttribute('data-room'));
  if (!node) throw new Error('no project in the rail');
  return `/p/${node}`;
}

/** Every canvas refuses WebGL from the page's first script on, as a browser without it would. */
export async function disableWebgl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      return String(args[0]).includes('webgl')
        ? null
        : (getContext.apply(this, args as Parameters<typeof getContext>) as never);
    } as typeof getContext;
  });
}

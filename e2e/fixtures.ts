import { test as base, expect, type Page } from '@playwright/test';
import { E2E_COOKIE, E2E_URL } from './env.js';

export type Theme = 'dark' | 'light';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is unset; run through the e2e Playwright config`);
  return value;
}

/** Tests get a page that is already signed in to the demo board. */
export const test = base.extend<{ theme: Theme }>({
  theme: ['dark', { option: true }],
  baseURL: async ({}, use) => use(required(E2E_URL)),
  colorScheme: async ({ theme }, use) => use(theme),
  storageState: async ({}, use) => use(signedInState(required(E2E_URL), required(E2E_COOKIE))),
  page: async ({ page, theme }, use) => {
    await page.addInitScript((value) => localStorage.setItem('cboard.theme', value), theme);
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

/** Opens a hash route and waits until the demo snapshot has rendered the project rail. */
export async function openRoute(page: Page, route: string): Promise<void> {
  await page.goto(`/#${route}`);
  await expect(page.locator('a[href^="#/p/"]').first()).toBeVisible();
}

/** The route of the first demo project, read from the rail. */
export async function firstProjectRoute(page: Page): Promise<string> {
  const href = await page.locator('a[href^="#/p/"]').first().getAttribute('href');
  if (!href) throw new Error('no project in the rail');
  return href.slice(1);
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

import { expect, firstProjectRoute, openRoute, test } from './fixtures.js';

test('the demo board loads, navigates to a project and opens settings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await openRoute(page, '/');
  await expect(page).toHaveTitle(/Yardmaster/);

  const project = await firstProjectRoute(page);
  await page.locator(`a[href="#${project}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`#${project}$`));

  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the API rejects requests without the session cookie', async ({ baseURL }) => {
  const response = await fetch(new URL('/api/status', baseURL));
  expect(response.status).toBe(401);
});

import { expect, test } from './fixtures.js';

// 12.7: the Yardmaster brand assets the web build renders, and the onboarding's brand moment.

test('the build serves the manifest, its icons and the static brand assets', async ({
  request,
}) => {
  const html = await (await request.get('/')).text();
  expect(html).toContain('<title>Yardmaster</title>');
  expect(html).toContain('rel="manifest"');
  // The loading state before the script runs is the still logomark.
  expect(html).toMatch(/<div data-boot-mark[^>]*><svg [^>]*viewBox="0 0 256 256"/);

  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const body = (await manifest.json()) as {
    name: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  expect(body.name).toBe('Yardmaster');
  expect(new Set(body.icons.map((icon) => icon.purpose))).toEqual(
    new Set(['any', 'maskable', 'monochrome']),
  );
  const files = [
    ...body.icons.map((icon) => icon.src),
    '/favicon.png',
    '/apple-touch-icon.png',
    '/og-image.png',
  ];
  for (const file of files) {
    const res = await request.get(file);
    expect(res.ok(), file).toBe(true);
    expect(res.headers()['content-type'], file).toBe('image/png');
  }
  const svg = await request.get('/favicon.svg');
  expect(svg.headers()['content-type']).toBe('image/svg+xml');
  expect(await svg.text()).toContain('viewBox="0 0 256 256"');
});

test('the brand moment plays once per browser, at Full only', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'full'));
  await page.goto('/#/welcome');
  const header = page.locator('[data-onboarding] header');
  await expect(header.locator('[data-brand-intro]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('yardmaster.brandIntro')))
    .toBe('seen');

  await page.reload();
  await expect(header.locator('svg')).toBeVisible();
  await expect(header.locator('[data-brand-intro]')).toHaveCount(0);
});

test('Reduced motion shows the still mark', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yardmaster.motion', 'reduced'));
  await page.goto('/#/welcome');
  const header = page.locator('[data-onboarding] header');
  await expect(header.locator('svg')).toBeVisible();
  await expect(header.locator('[data-brand-intro]')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('yardmaster.brandIntro'))).toBeNull();
});

test('preferences saved under the old c-board names carry over (12.7a)', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('cboard.layout', 'retro');
    localStorage.setItem('cboard.brandIntro', 'seen');
  });
  await page.goto('/');
  const stored = await page.evaluate(() => ({
    layout: localStorage.getItem('yardmaster.layout'),
    intro: localStorage.getItem('yardmaster.brandIntro'),
    old: Object.keys(localStorage).filter((key) => key.startsWith('cboard.')),
  }));
  expect(stored).toEqual({ layout: 'retro', intro: 'seen', old: [] });
  // The layout read the moved key: the Retro overview loads.
  await expect(page.locator('[data-retro-frame]').first()).toBeVisible({ timeout: 20_000 });
});

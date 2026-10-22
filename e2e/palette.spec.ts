import { expect, openRoute, test } from './fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('the palette navigates to a project and runs an action there', async ({ page }) => {
  await openRoute(page, '/');
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  for (const group of ['Projects', 'Sessions', 'Terminals', 'Actions']) {
    await expect(palette.locator('[cmdk-group-heading]', { hasText: group })).toBeVisible();
  }

  // A fuzzy query highlights the matched letters and selects the best result.
  const input = palette.getByRole('combobox');
  await input.fill('orbapi');
  const project = palette.locator('[data-command^="project:"]', { hasText: 'orbit-api' });
  await expect(project).toHaveAttribute('data-selected', 'true');
  await expect(project.locator('mark')).toHaveText(['orb', 'api']);
  await input.press('Enter');

  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/#\/p\/[^/]+$/);
  const focus = page.locator('[data-focus]');
  await expect(focus.getByRole('heading', { level: 1 })).toHaveText('orbit-api');

  // In the focus view, project actions target the focused project.
  await page.keyboard.press('ControlOrMeta+K');
  await expect(palette).toBeVisible();
  await input.fill('rerun');
  const rerun = palette.locator('[data-command="rerun-last"]');
  await expect(rerun).toContainText('Re-run last command');
  const command = (await rerun.locator('.font-mono').textContent())?.trim() ?? '';
  expect(command).not.toBe('');
  await input.press('Enter');
  await expect(palette).toBeHidden();
  await expect(
    page.locator('[data-sonner-toast]', { hasText: `Re-running ${command}` }),
  ).toBeVisible();
  // Still in the project.
  await expect(focus.getByRole('heading', { level: 1 })).toHaveText('orbit-api');
});

test('the palette toggles the theme and opens from the HUD hint', async ({ page }) => {
  await openRoute(page, '/');
  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', 'light');
  await page.locator('[data-hud="palette-hint"]').click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('theme');
  await expect(palette.locator('[data-command="theme"]')).toContainText('Switch theme to Light');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('a new board session asks for a prompt, and Esc backs out step by step', async ({ page }) => {
  await openRoute(page, '/');
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const input = palette.getByRole('combobox');
  await input.fill('new session acme');
  await expect(
    palette.locator('[data-command^="new-session:"]', { hasText: 'acme-shop' }),
  ).toHaveAttribute('data-selected', 'true');
  await input.press('Enter');

  const prompt = palette.getByPlaceholder('What should Claude do in acme-shop?');
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(palette.getByPlaceholder('Search or run a command')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('picking a terminal opens it in the focus view', async ({ page }) => {
  await openRoute(page, '/');
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('server orbit');
  await palette.locator('[data-command^="terminal:"]', { hasText: 'server' }).click();
  await expect(palette).toBeHidden();
  const stack = page.locator('[data-terminal-stack]');
  await expect(stack.getByRole('tab', { name: /^server\b/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

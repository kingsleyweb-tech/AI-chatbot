import { expect, test, type Page } from '@playwright/test';

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('signed-out visitors are sent to the sign-in screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible();
  await noHorizontalScroll(page);
});

test('form inputs are at least 16px so iOS Safari does not zoom on focus', async ({ page }) => {
  await page.goto('/login');
  for (const id of ['email', 'password']) {
    const size = await page.locator(`#${id}`).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, `#${id} font-size`).toBeGreaterThanOrEqual(16);
  }
});

test('deep links to protected pages also require sign-in', async ({ page }) => {
  await page.goto('/settings/models');
  await expect(page).toHaveURL(/\/login$/);
});

test('password reset screen renders without overflow', async ({ page }) => {
  await page.goto('/reset');
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await noHorizontalScroll(page);
});

test('PWA metadata for Add to Home Screen is present', async ({ page, request }) => {
  await page.goto('/login');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveCount(1);
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover');
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
  expect((await request.get('/apple-touch-icon.png')).status()).toBe(200);
  expect((await request.get('/sw.js')).status()).toBe(200);
});

// Opt-in visual check: SHOTS_DIR=<dir> npx playwright test -g screenshots
test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture screenshots');
  for (const [name, path, heading] of [['login', '/login', 'Welcome back'], ['reset', '/reset', 'Reset your password']] as const) {
    await page.goto(path);
    await page.getByRole('heading', { name: heading }).waitFor();
    await page.screenshot({ path: `${process.env.SHOTS_DIR}/${info.project.name}-${name}.png` });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await page.screenshot({ path: `${process.env.SHOTS_DIR}/${info.project.name}-login-dark.png` });
});

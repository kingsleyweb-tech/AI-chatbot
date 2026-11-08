import { expect, test, type Page } from '@playwright/test';

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('signed-out visitors are sent to the sign-in screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome to Atlas AI' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible();
  await noHorizontalScroll(page);
});

test('sign-in offers Google then email, and no Apple option', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('Your intelligent assistant for thinking, creating and discovering.')).toBeVisible();
  const google = page.getByRole('button', { name: 'Continue with Google' });
  await expect(google).toBeVisible();
  await expect(page.getByRole('button', { name: /Apple/ })).toHaveCount(0);
  await expect(page.getByText('OR CONTINUE WITH EMAIL')).toBeVisible();
  const [g, e] = await Promise.all([google.boundingBox(), page.locator('#email').boundingBox()]);
  expect(g!.y).toBeLessThan(e!.y);
  await noHorizontalScroll(page);
});

test('empty email sign-in shows a validation message', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter your email and password.');
});

test('phone verification page requires sign-in', async ({ page }) => {
  await page.goto('/verify-phone');
  await expect(page).toHaveURL(/\/login$/);
});

test('pinch zoom is not disabled', async ({ page }) => {
  await page.goto('/login');
  const vp = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';
  expect(vp).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/);
});

test('form inputs are at least 16px so iOS Safari does not zoom on focus', async ({ page }) => {
  await page.goto('/login');
  for (const id of ['email', 'password']) {
    const size = await page.locator(`#${id}`).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, `#${id} font-size`).toBeGreaterThanOrEqual(16);
  }
});

test('buttons get a finger-sized hit area beyond their visible edge on touch screens', async ({ page }) => {
  await page.goto('/login');
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  const box = (await button.boundingBox())!;
  const hit = await page.evaluate(
    ({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('button')?.textContent?.trim() ?? null,
    { x: box.x + box.width / 2, y: box.y + box.height + 4 },
  );
  expect(hit).toBe('Sign in');
});

test('deep links to protected pages also require sign-in', async ({ page }) => {
  await page.goto('/settings/models');
  await expect(page).toHaveURL(/\/login$/);
});

test('password reset screen renders without overflow', async ({ page }) => {
  await page.goto('/reset');
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text me a code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Email me a reset link instead' })).toBeVisible();
  await noHorizontalScroll(page);
});

test('reset rejects an invalid email before contacting the server', async ({ page }) => {
  let called = false;
  await page.route('**/api/recovery', (route) => {
    called = true;
    return route.abort();
  });
  await page.goto('/reset');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByRole('button', { name: 'Text me a code' }).click();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  expect(called).toBe(false);
});

test('admin and security pages require sign-in', async ({ page }) => {
  for (const path of ['/admin/users', '/settings/security']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test('privacy policy and terms are public, dated, marked as drafts and fit a phone screen', async ({ page }) => {
  for (const [path, title] of [
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Use'],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByText(/Last updated:/)).toBeVisible();
    await expect(page.getByRole('note')).toContainText('has not been reviewed by a lawyer');
    await expect(page.getByText('Still to be confirmed by the operator')).toBeVisible();
    await noHorizontalScroll(page);
  }
});

test('the sign-in screen links to the privacy policy and terms', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Privacy Policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link', { name: 'Terms of Use' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of Use' })).toBeVisible();
});

test('support, help, notifications and admin support pages require sign-in', async ({ page }) => {
  for (const path of ['/support', '/support/new', '/support/ATL-2611-ABCDE', '/help', '/notifications', '/admin/support', '/admin/support/ATL-2611-ABCDE']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
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
  for (const [name, path, heading] of [['login', '/login', 'Welcome to Atlas AI'], ['reset', '/reset', 'Reset your password']] as const) {
    await page.goto(path);
    await page.getByRole('heading', { name: heading }).waitFor();
    await page.screenshot({ path: `${process.env.SHOTS_DIR}/${info.project.name}-${name}.png` });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  await page.getByRole('heading', { name: 'Welcome to Atlas AI' }).waitFor();
  await page.screenshot({ path: `${process.env.SHOTS_DIR}/${info.project.name}-login-dark.png` });
});

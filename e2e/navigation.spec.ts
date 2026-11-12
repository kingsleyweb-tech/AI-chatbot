import { expect, test, type Page } from '@playwright/test';

/** Make the page believe it runs as the installed app (display-mode: standalone). */
async function asInstalledApp(page: Page) {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => {
      if (q.includes('display-mode: standalone')) {
        return { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as unknown as MediaQueryList;
      }
      return real(q);
    };
  });
}

test.describe('website (signed out)', () => {
  test('after a sign-out the home page explains why once, then cleans the address', async ({ page }) => {
    await page.goto('/?signedOut=inactivity');
    await expect(page.getByRole('status').filter({ hasText: 'signed out after 60 minutes of inactivity' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText('signed out after 60 minutes of inactivity')).toHaveCount(0);
  });

  test('a manual sign-out lands on the home page with a short notice', async ({ page }) => {
    await page.goto('/?signedOut=user');
    await expect(page.getByText('You have signed out.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/login');
  });

  test('an unknown reason shows no notice', async ({ page }) => {
    await page.goto('/?signedOut=<script>');
    await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveCount(0);
  });

  test('app pages stay protected: they open the sign-in form', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('public pages and the home link on the sign-in page are available', async ({ page }) => {
    await page.goto('/about');
    await expect(page).toHaveURL(/\/about$/);
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Atlas AI home' })).toBeVisible();
  });
});

test.describe('installed app (signed out)', () => {
  test.beforeEach(async ({ page }) => asInstalledApp(page));

  test('opens on the sign-in form, not the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('link', { name: 'Atlas AI home' })).toHaveCount(0);
  });

  test('public website pages and unknown addresses go to the sign-in form', async ({ page }) => {
    for (const path of ['/about', '/features', '/blog', '/no-such-page']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
  });

  test('legal pages stay readable', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page).toHaveURL(/\/privacy$/);
    await page.goto('/terms');
    await expect(page).toHaveURL(/\/terms$/);
  });

  test('a sign-out reason is shown on the sign-in form', async ({ page }) => {
    await page.goto('/login?reason=inactivity');
    await expect(page.getByText('signed out after 60 minutes of inactivity')).toBeVisible();
  });
});

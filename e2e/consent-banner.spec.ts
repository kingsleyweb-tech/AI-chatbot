import { expect, test, type Page } from '@playwright/test';

// Google Analytics must not load before the visitor allows it.
const GA = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com/;
const banner = (page: Page) => page.getByRole('region', { name: 'Analytics choice' });

function watchAnalytics(page: Page) {
  const hits: string[] = [];
  page.on('request', (r) => {
    if (GA.test(r.url())) hits.push(r.url());
  });
  return hits;
}

test('the analytics banner asks first, and declining keeps analytics off after a reload', async ({ page }) => {
  const hits = watchAnalytics(page);
  await page.goto('/login');
  await expect(banner(page)).toBeVisible();
  await expect(banner(page).getByRole('button', { name: 'Decline' })).toBeVisible();
  await expect(banner(page).getByRole('button', { name: 'Allow analytics' })).toBeVisible();
  // no horizontal scroll on a phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // analytics would load after 4 s if it ignored the missing choice
  await page.waitForTimeout(5000);
  expect(hits).toEqual([]);

  await banner(page).getByRole('button', { name: 'Decline' }).click();
  await expect(banner(page)).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('atlas.analyticsConsent'))).toBe('denied');
  await page.reload();
  await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
  await expect(banner(page)).toBeHidden();
  await page.waitForTimeout(5000);
  expect(hits).toEqual([]);
});

test('allowing analytics is remembered, and the Privacy Policy switch can withdraw it', async ({ page }) => {
  await page.goto('/privacy');
  await banner(page).getByRole('button', { name: 'Allow analytics' }).click();
  await expect(banner(page)).toBeHidden();
  const sw = page.getByRole('switch', { name: 'Usage analytics' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => localStorage.getItem('atlas.analyticsConsent'))).toBe('denied');
  expect(await page.evaluate(() => document.cookie.includes('_ga'))).toBe(false);
});

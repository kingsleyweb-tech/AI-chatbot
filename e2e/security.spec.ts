import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// vite preview does not apply vercel.json, so the production CSP is added to
// every same-origin response here and any violation fails the test.
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] };
const CSP = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')!.value.replace('; upgrade-insecure-requests', '');

async function withCsp(page: Page) {
  await page.route('http://127.0.0.1:4173/**', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': CSP } });
  });
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`Refused to load (CSP) ${e.violatedDirective} ${e.blockedURI}`));
  });
  return violations;
}

for (const path of ['/login', '/register', '/reset', '/privacy', '/terms']) {
  test(`${path} renders under the production CSP with no violations`, async ({ page }) => {
    const violations = await withCsp(page);
    await page.goto(path);
    await expect(page.locator('#root')).not.toBeEmpty();
    // the inline theme script (allowed by hash) ran before first paint
    await expect(page.locator('html')).toHaveAttribute('data-accent', /.+/);
    await page.waitForTimeout(5000); // Analytics loads late; give it time to show up if it is blocked
    expect(violations).toEqual([]);
  });
}

test('the CSP check itself catches a violation (negative control)', async ({ page }) => {
  const violations = await withCsp(page);
  await page.goto('/login');
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = 1';
    document.head.appendChild(s);
  });
  await expect.poll(() => violations.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();
});

test('after an inactivity sign-out the sign-in page explains why, once', async ({ page }) => {
  await page.goto('/login?reason=inactivity');
  await expect(page.getByRole('status')).toHaveText(/signed out after 60 minutes of inactivity/);
  await expect(page).toHaveURL(/\/login$/);
  await page.reload();
  await expect(page.getByText(/60 minutes of inactivity/)).toHaveCount(0);
});

test('signed-out visitors cannot open protected or administrator pages', async ({ page }) => {
  for (const path of ['/admin', '/admin/users', '/admin/sms', '/settings', '/projects', '/c/some-chat']) {
    await page.goto(path, { waitUntil: 'commit' });
    await expect(page).toHaveURL(/\/login$/);
  }
});

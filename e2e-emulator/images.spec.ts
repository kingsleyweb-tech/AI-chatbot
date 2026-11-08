import { readFile } from 'node:fs/promises';
import { devices, expect, test, type Page } from '@playwright/test';

// Image creation, end to end: real browser, dev server with the scripted AI and the scripted
// Cloudflare Workers AI (E2E_FAKE_AI=1, no request reaches Cloudflare), Auth and Firestore
// emulators. Setup: see playwright.emulator.config.ts.
const EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Passw0rd!e2e';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-tessera/databases/(default)/documents';
const OWNER = { authorization: 'Bearer owner' };
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let uid = '';
test.beforeAll(async () => {
  const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  uid = ((await r.json()) as { localId: string }).localId;
  expect(uid).toBeTruthy();
  // a clean per-user daily image count for this run
  const day = new Date().toISOString().slice(0, 10);
  await fetch(`${FS}/users/${uid}/usage/${day}`, { method: 'DELETE', headers: OWNER });
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** the server allows one image request per user every 8 seconds */
const GAP = 8_500;
const composer = (page: Page) => page.getByLabel('Message', { exact: true });
const indicator = (page: Page) => page.locator('[data-generation-indicator]');
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });
const images = (page: Page) => page.locator('figure[data-generated-image]');
const cidOf = (page: Page) => /\/c\/([^/?#]+)/.exec(page.url())?.[1] ?? '';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Gemini|free/i }).first()).toBeVisible({ timeout: 30_000 });
  await pause(1500);
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

async function waitDone(page: Page) {
  await expect(stopButton(page)).toBeHidden({ timeout: 90_000 });
  await expect(indicator(page)).toHaveCount(0, { timeout: 30_000 });
}

async function fsList(path: string) {
  const r = await fetch(`${FS}/${path}?pageSize=300`, { headers: OWNER });
  return ((await r.json()) as { documents?: { name: string; fields: Record<string, Record<string, unknown>> }[] }).documents ?? [];
}
const field = (d: { fields: Record<string, Record<string, unknown>> }, k: string) => Object.values(d.fields[k] ?? {})[0];

async function download(page: Page, button: ReturnType<Page['locator']>) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), button.click()]);
  const path = await dl.path();
  const bytes = new Uint8Array(await readFile(path));
  return { name: dl.suggestedFilename(), bytes };
}

test.describe.configure({ mode: 'serial' });

test.describe('desktop', () => {
  let cid = '';
  let firstId = '';

  test('1. a direct request creates an image: indicator, display, Download in original quality', async ({ page }) => {
    await signIn(page);
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
    await send(page, 'Generate a landscape image of a lion in a forest at sunset');
    await expect(page.getByText('Generate a landscape image of a lion in a forest at sunset').first()).toBeVisible();
    await expect(indicator(page)).toContainText('Creating your image…', { timeout: 20_000 });
    await waitDone(page);
    await expect(images(page)).toHaveCount(1);
    const fig = images(page).first();
    await expect(fig.locator('img')).toBeVisible();
    await expect(page.getByText(/Created an image/).first()).toBeVisible();
    // correct shape: landscape box, not stretched
    const box = await fig.locator('img').boundingBox();
    expect(box!.width / box!.height).toBeGreaterThan(1.5);
    await expect(fig).toContainText('PNG');
    cid = cidOf(page);
    firstId = (await fig.getAttribute('data-generated-image'))!;
    expect(firstId).toMatch(/^img_/);

    const { name, bytes } = await download(page, fig.getByRole('button', { name: 'Download' }));
    expect(name).toMatch(/^atlas-image-\d{8}-\d{4}-[a-z0-9-]*lion[a-z0-9-]*\.png$/);
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIG);

    // stored outside the message: metadata + chunk docs; the message holds no image data
    const meta = (await fsList(`users/${uid}/generatedImages`)).find((d) => d.name.endsWith(`/${firstId}`))!;
    expect(meta).toBeTruthy();
    expect(field(meta, 'uid')).toBe(uid);
    expect(field(meta, 'conversationId')).toBe(cid);
    expect(field(meta, 'status')).toBe('ready');
    expect(field(meta, 'prompt')).toMatch(/lion/);
    const chunks = (await fsList(`users/${uid}/generatedImageData`)).filter((d) => d.name.includes(`/${firstId}_`));
    expect(chunks.length).toBe(Number(field(meta, 'chunks')));
    // the stored bytes are exactly what was downloaded
    const stored = Buffer.concat(chunks.sort((a, b) => a.name.localeCompare(b.name)).map((c) => Buffer.from(String(field(c, 'data') ?? field(c, 'bytesValue') ?? Object.values(c.fields).map((v) => v.bytesValue).find(Boolean)), 'base64')));
    expect(stored.equals(Buffer.from(bytes))).toBe(true);
    const msgs = await fsList(`users/${uid}/conversations/${cid}/messages`);
    expect(JSON.stringify(msgs)).not.toMatch(/data:image|base64,/);
  });

  test('2. the image survives a reload and can still be downloaded', async ({ page }) => {
    await signIn(page);
    await page.goto(`/c/${cid}`);
    await expect(images(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(images(page).first().locator('img')).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(images(page).first().locator('img')).toBeVisible({ timeout: 30_000 });
    const { bytes } = await download(page, images(page).first().getByRole('button', { name: 'Download' }));
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIG);
  });

  test('3. a follow-up edit creates a separate image and keeps the original', async ({ page }) => {
    await pause(GAP);
    await signIn(page);
    await page.goto(`/c/${cid}`);
    await expect(images(page)).toHaveCount(1, { timeout: 30_000 });
    await send(page, 'Make it more realistic');
    await expect(indicator(page)).toContainText('Creating your image…', { timeout: 20_000 });
    await waitDone(page);
    await expect(images(page)).toHaveCount(2);
    await expect(page.getByText(/Edited the image/).first()).toBeVisible();
    const metas = await fsList(`users/${uid}/generatedImages`);
    const edit = metas.find((d) => field(d, 'kind') === 'edit' && field(d, 'conversationId') === cid)!;
    expect(field(edit, 'sourceImageId')).toBe(firstId);
    expect(metas.some((d) => d.name.endsWith(`/${firstId}`))).toBe(true);
  });

  test('4. questions about images get a normal answer; unsafe requests are refused without an image', async ({ page }) => {
    await signIn(page);
    await page.goto('/');
    await send(page, 'Which AI model is best for generating images?');
    await waitDone(page);
    await expect(images(page)).toHaveCount(0);
    await expect(page.getByText(/Created an image/)).toHaveCount(0);

    await page.goto('/');
    await send(page, 'Generate an image of a nude woman on a beach');
    await waitDone(page);
    await expect(page.getByText(/can’t create that image/).first()).toBeVisible();
    await expect(images(page)).toHaveCount(0);

    await pause(GAP);
    await page.goto('/');
    await send(page, 'Generate an image of UNSAFEGUARD scene');
    await waitDone(page);
    await expect(page.getByText(/can’t create that image/).first()).toBeVisible();
    await expect(images(page)).toHaveCount(0);
  });

  test('5. a failed generation shows an error with Retry and stores nothing', async ({ page }) => {
    await pause(GAP);
    await signIn(page);
    await page.goto('/');
    const before = (await fsList(`users/${uid}/generatedImages`)).length;
    await send(page, 'Generate an image of a FAILIMAGE cat');
    await waitDone(page);
    await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
    await expect(images(page)).toHaveCount(0);
    expect((await fsList(`users/${uid}/generatedImages`)).length).toBe(before);
    // the user message is kept
    await page.reload();
    await expect(page.getByText('Generate an image of a FAILIMAGE cat').first()).toBeVisible({ timeout: 30_000 });
  });

  test('6. gallery: images stay after signing out and in, download from the gallery, delete', async ({ page, browser }) => {
    await signIn(page);
    await page.goto('/settings');
    await page.getByRole('button', { name: /^Sign out$/ }).first().click();
    await page.getByRole('button', { name: /^Sign out$/ }).last().click().catch(() => undefined);
    await expect(page).toHaveURL(/login/, { timeout: 30_000 });
    await signIn(page);
    await page.goto('/images');
    const cards = page.locator('[data-gallery-image]');
    const first = page.locator(`[data-gallery-image="${firstId}"]`);
    await expect(first).toBeVisible({ timeout: 30_000 });
    const total = await cards.count();
    expect(total).toBeGreaterThanOrEqual(2);
    await expect(first).toContainText('lion');
    await first.scrollIntoViewIfNeeded();
    await expect(first.locator('img')).toBeVisible({ timeout: 30_000 });
    const { name, bytes } = await download(page, first.getByRole('button', { name: 'Download' }));
    expect(name).toMatch(/\.png$/);
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIG);

    await first.getByRole('button', { name: 'Delete image' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Delete/ }).click();
    await expect(first).toHaveCount(0, { timeout: 20_000 });
    await expect(cards).toHaveCount(total - 1);
    expect((await fsList(`users/${uid}/generatedImages`)).some((d) => d.name.endsWith(`/${firstId}`))).toBe(false);
    expect((await fsList(`users/${uid}/generatedImageData`)).some((d) => d.name.includes(`/${firstId}_`))).toBe(false);
    // On another device (a fresh browser profile, no offline cache) the conversation still opens:
    // the deleted picture is reported as gone and the edit still shows.
    const other = await browser.newContext();
    const page2 = await other.newPage();
    await signIn(page2);
    await page2.goto(`/c/${cid}`);
    await expect(page2.getByText('Make it more realistic').first()).toBeVisible({ timeout: 30_000 });
    await expect(images(page2)).toHaveCount(2, { timeout: 30_000 });
    await expect(images(page2).first()).toContainText('This image was deleted', { timeout: 30_000 });
    await expect(images(page2).nth(1).locator('img')).toBeVisible({ timeout: 30_000 });
    await other.close();
  });
});

test.describe('iPhone', () => {
  // same engine (WebKit) as the desktop project, so only the device settings change
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { defaultBrowserType, ...iphone } = devices['iPhone 15'];
  test.use(iphone);

  test('7. on a phone: create, display at the right shape, and download', async ({ page }) => {
    await pause(GAP);
    await signIn(page);
    await page.goto('/');
    await send(page, 'Create a tall vertical image of a lighthouse on a cliff');
    await expect(indicator(page)).toContainText('Creating your image…', { timeout: 20_000 });
    await waitDone(page);
    const fig = images(page).first();
    await expect(fig.locator('img')).toBeVisible();
    const box = await fig.locator('img').boundingBox();
    expect(box!.height / box!.width).toBeGreaterThan(1.5);
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    // no horizontal page scroll
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const { name, bytes } = await download(page, fig.getByRole('button', { name: 'Download' }));
    expect(name).toMatch(/^atlas-image-\d{8}-\d{4}-[a-z0-9-]*lighthouse[a-z0-9-]*\.png$/);
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIG);
  });
});

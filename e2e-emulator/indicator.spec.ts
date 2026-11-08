import { expect, test, type Page } from '@playwright/test';

// The generation indicator ("Thinking…" / "Generating response…" / "Saving response…"), end to end:
// real browser, dev server with the scripted AI (E2E_FAKE_AI=1), Auth and Firestore emulators.
// Setup: see playwright.emulator.config.ts.
const EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Passw0rd!e2e';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-tessera/databases/(default)/documents';
const OWNER = { authorization: 'Bearer owner' };

let uid = '';
test.beforeAll(async () => {
  const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  uid = ((await r.json()) as { localId: string }).localId;
  expect(uid).toBeTruthy();
});

async function lastReplyStatus(cid: string): Promise<string> {
  const r = await fetch(`${FS}/users/${uid}/conversations/${cid}/messages?pageSize=300`, { headers: OWNER });
  const body = (await r.json()) as { documents?: { fields: Record<string, Record<string, string>> }[] };
  const docs = (body.documents ?? []).map((d) => ({
    role: Object.values(d.fields.role ?? {})[0],
    status: Object.values(d.fields.status ?? {})[0],
    createdAt: Object.values(d.fields.createdAt ?? {})[0] ?? '',
  }));
  return docs.filter((d) => d.role === 'assistant').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.status ?? '';
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const composer = (page: Page) => page.getByLabel('Message', { exact: true });
const indicator = (page: Page) => page.locator('[data-generation-indicator]');
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });
/** Sends with the button (on phones, Enter adds a new line by design). */
const submit = (page: Page) => page.getByRole('button', { name: 'Send message' }).click();
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

/** A fresh chat, with a recorder that samples the indicator every 20 ms. */
async function freshChat(page: Page) {
  await page.goto('/');
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await pause(1000);
}

type Sample = { phase: string | null; label: string; stop: boolean; answer: boolean };

async function record(page: Page, answerMarker: string) {
  await page.evaluate((marker) => {
    const w = window as unknown as { __samples: Sample[]; __timer?: number };
    clearInterval(w.__timer);
    w.__samples = [];
    w.__timer = window.setInterval(() => {
      const el = document.querySelector('[data-generation-indicator]');
      w.__samples.push({
        phase: el?.getAttribute('data-generation-indicator') ?? null,
        label: el?.textContent ?? '',
        stop: Boolean(document.querySelector('button[aria-label="Stop generating"]')),
        answer: (document.querySelector('main')?.innerText ?? '').includes(marker),
      });
    }, 20);
  }, answerMarker);
}

async function samples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __samples: Sample[]; __timer?: number };
    clearInterval(w.__timer);
    return w.__samples;
  });
}

/** The indicator is on for the whole generation, shown together with the streaming text, and off at the end. */
function expectFullLifecycle(all: Sample[]) {
  // compact trace of phase changes, attached to the report
  const changes = all.filter((s, i) => i === 0 || JSON.stringify(s) !== JSON.stringify(all[i - 1])).map((s) => `${s.phase ?? '-'}|${s.stop ? 'stop' : ''}|${s.answer ? 'text' : ''}|${s.label}`);
  test.info().annotations.push({ type: 'indicator-trace', description: changes.join(' > ') });
  console.log('[indicator-trace]', changes.join(' > '));
  const first = all.findIndex((s) => s.phase);
  expect(first, 'indicator appeared').toBeGreaterThanOrEqual(0);
  const lastOn = all.findLastIndex((s) => s.phase);
  // no gap: from the first appearance to the end it never disappeared and came back
  expect(all.slice(first, lastOn + 1).every((s) => s.phase), 'indicator stayed visible without gaps').toBe(true);
  // whenever a reply was generating (Stop shown), the indicator was there
  expect(all.filter((s) => s.stop && !s.phase), 'generating without an indicator').toHaveLength(0);
  expect(all.some((s) => s.phase === 'thinking'), 'thinking phase seen').toBe(true);
  // both at once: the streaming answer and the indicator
  expect(all.some((s) => s.phase === 'streaming' && s.answer && s.label.includes('Generating response')), 'indicator visible while text streams').toBe(true);
  // the indicator went away at the end
  expect(all.at(-1)!.phase, 'indicator hidden at the end').toBeNull();
}

async function sendAndRecord(page: Page, text: string, answerMarker: string) {
  await record(page, answerMarker);
  await composer(page).fill(text);
  await submit(page);
  await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 });
  const cid = cidOf(page);
  await expect.poll(() => lastReplyStatus(cid), { timeout: 90_000 }).toBe('complete');
  await expect(indicator(page)).toHaveCount(0, { timeout: 30_000 });
  await pause(300); // a few more samples after the end
  return { cid, all: await samples(page) };
}

for (const device of [
  { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
]) {
  test.describe.serial(`generation indicator (${device.name})`, () => {
    test.use(device.use);

    test('short reply: indicator from send until the reply is stored', async ({ page }) => {
      await signIn(page);
      await freshChat(page);
      // even a one-word reply streams; the indicator must cover thinking and the answer
      const { all } = await sendAndRecord(page, 'Indicator short: write 3 numbered lines about tea, then the word STEEPED.', 'Scripted line number 1.');
      expectFullLifecycle(all);
      await expect(page.locator('main').getByText('STEEPED').first()).toBeVisible();
    });

    test('long reply (several seconds): indicator stays visible while text streams (Gemini)', async ({ page }) => {
      await signIn(page);
      await freshChat(page);
      await expect(page.getByRole('button', { name: /Gemini/ }).first()).toBeVisible();
      const { all } = await sendAndRecord(page, 'Indicator long: list 40 numbered facts about stars.', 'Scripted line number 3.');
      expectFullLifecycle(all);
      // it was on screen together with the text for most of the stream, not just a flash
      expect(all.filter((s) => s.phase === 'streaming' && s.answer).length).toBeGreaterThan(50);
    });

    test('reasoning request: "Thinking…" while it reasons, then "Generating response…" while it answers', async ({ page }) => {
      await signIn(page);
      await freshChat(page);
      const { all } = await sendAndRecord(page, 'Indicator reasoning: think step by step about why the sky is blue.', 'Step 1:');
      expectFullLifecycle(all);
      expect(all.some((s) => s.phase === 'thinking' && s.label.includes('Thinking'))).toBe(true);
      await expect(page.locator('main').getByText('REASONED').first()).toBeVisible();
    });

    test('OpenRouter model: same lifecycle', async ({ page }) => {
      await signIn(page);
      await freshChat(page);
      await page.getByRole('button', { name: /Gemini 3\.5 Flash/ }).first().click();
      await page.getByRole('button', { name: /Nemotron 3 Ultra \(free\).*via OpenRouter/ }).first().click();
      await expect(page.getByRole('button', { name: /Nemotron 3 Ultra/ }).first()).toBeVisible();
      const { all } = await sendAndRecord(page, 'Indicator openrouter: list 20 numbered facts about rivers.', 'Scripted line number 3.');
      expectFullLifecycle(all);
    });

    test('failed request: indicator ends and the error with Retry is shown', async ({ page }) => {
      await signIn(page);
      await freshChat(page);
      await page.route('**/api/chat', (route) =>
        route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'provider_error', message: 'The AI service is unavailable.' } }) }),
      );
      await record(page, 'never');
      await composer(page).fill('Indicator failure: reply with only the word NOPE.');
      await submit(page);
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('The AI service is unavailable.')).toBeVisible();
      await expect(indicator(page)).toHaveCount(0);
      await pause(300);
      const all = await samples(page);
      expect(all.filter((s) => s.stop && !s.phase)).toHaveLength(0);
      expect(all.at(-1)!.phase).toBeNull();
      await page.unroute('**/api/chat');
    });

    test('Stop: indicator ends and "Stopped before it finished" is shown', async ({ page }) => {
      await signIn(page);
      await freshChat(page);
      await record(page, 'Scripted line number 3.');
      await composer(page).fill('Indicator stop: list 60 numbered facts about clocks.');
      await submit(page);
      await expect(page.locator('main').getByText('Scripted line number 3.').first()).toBeVisible({ timeout: 30_000 });
      await expect(indicator(page)).toHaveAttribute('data-generation-indicator', 'streaming');
      await stopButton(page).click();
      await expect(indicator(page)).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText('Stopped before it finished')).toBeVisible();
      const cid = cidOf(page);
      await expect.poll(() => lastReplyStatus(cid), { timeout: 60_000 }).toBe('stopped');
      const all = await samples(page);
      expect(all.filter((s) => s.stop && !s.phase)).toHaveLength(0);
      expect(all.at(-1)!.phase).toBeNull();
    });

    test('connection lost mid-reply: indicator does not stay stuck', async ({ page, context }) => {
      await signIn(page);
      await freshChat(page);
      await composer(page).fill('Indicator offline: list 60 numbered facts about bridges.');
      await submit(page);
      await expect(page.locator('main').getByText('Scripted line number 3.').first()).toBeVisible({ timeout: 30_000 });
      await context.setOffline(true);
      await pause(4000);
      await context.setOffline(false);
      // the reply either finished or was interrupted; either way the indicator ends
      await expect(indicator(page)).toHaveCount(0, { timeout: 60_000 });
      await expect(stopButton(page)).toBeHidden();
    });
  });
}

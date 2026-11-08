import { expect, test, webkit, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Conversation persistence, end to end: real browser, real dev server (/api/chat with the free
// Gemini tier), Auth and Firestore EMULATORS (project demo-tessera). The account is created by
// the seed script described in playwright.emulator.config.ts.
const EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Passw0rd!e2e';
const PROJECT = 'demo-tessera';
const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { authorization: 'Bearer owner' };

type Stored = { id: string; role: string; content: string; status: string; model?: string; createdAt: string };

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

/** Every message of a conversation as stored in Firestore, oldest first. */
async function stored(cid: string): Promise<Stored[]> {
  const r = await fetch(`${FS}/users/${uid}/conversations/${cid}/messages?pageSize=300`, { headers: OWNER });
  const body = (await r.json()) as { documents?: { name: string; fields: Record<string, Record<string, string>> }[] };
  const docs = (body.documents ?? []).map((d) => {
    const f = d.fields;
    const val = (k: string) => (f[k] ? Object.values(f[k])[0] : undefined) as string | undefined;
    return {
      id: d.name.split('/').pop()!,
      role: val('role') ?? '',
      content: val('content') ?? '',
      status: val('status') ?? '',
      model: val('model'),
      createdAt: val('createdAt') ?? '',
    };
  });
  return docs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
async function conversationExists(cid: string) {
  return (await fetch(`${FS}/users/${uid}/conversations/${cid}`, { headers: OWNER })).ok;
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 30_000 });
  // let the profile, settings and model list finish loading before typing
  await expect(page.getByRole('button', { name: /Gemini|free/i }).first()).toBeVisible({ timeout: 30_000 });
  await pause(2000);
}

const composer = (page: Page) => page.getByLabel('Message', { exact: true });
const cidOf = (page: Page) => /\/c\/([^/?#]+)/.exec(page.url())?.[1] ?? '';

/** Waits for the reply to finish streaming in the UI. */
async function replyDone(page: Page) {
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({ timeout: 90_000 });
}

/** Waits until the conversation's last assistant message is stored with a final status. */
async function storedSettled(cid: string, assistants: number) {
  await expect
    .poll(async () => (await stored(cid)).filter((m) => m.role === 'assistant' && m.status !== 'processing').length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(assistants);
}

async function send(page: Page, text: string) {
  await replyDone(page); // the app (correctly) ignores Enter while a reply is generating
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('', { timeout: 15_000 }); // accepted
  await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 });
  const cid = cidOf(page);
  // the question is stored, followed by its reply with a final status
  await expect
    .poll(
      async () => {
        const all = await stored(cid);
        const i = all.findIndex((m) => m.role === 'user' && m.content === text);
        return i >= 0 && all[i + 1]?.role === 'assistant' && all[i + 1].status !== 'processing';
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  await replyDone(page);
}

/** The text of the conversation pane (to check what the user can see, in order). */
async function visibleOrder(page: Page, needles: string[]) {
  const text = await page.locator('main').innerText();
  const positions = needles.map((n) => text.indexOf(n));
  return { text, positions };
}

/** "New chat", then wait until the new-chat screen has actually rendered (navigation renders asynchronously). */
async function newChat(page: Page) {
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await expect(page.getByText('What can I help you with today?')).toBeVisible();
  await expect(composer(page)).toHaveValue('');
}

/** Opens a conversation from the sidebar and waits until its content is on screen (navigation renders asynchronously). */
async function openInSidebar(page: Page, cid: string, marker: string) {
  await page.locator(`a[href="/c/${cid}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/c/${cid}$`));
  await expect(page.locator('main').getByText(marker, { exact: false }).first()).toBeVisible();
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe.serial('conversation persistence', () => {
  let convA = '';
  let convB = '';
  let convC = '';

  test('1. ten messages in one conversation: every message and reply is kept, in order', async ({ page }) => {
    await signIn(page);
    for (let i = 1; i <= 10; i++) {
      await send(page, `Question ${i}: reply with only the number ${i * 11}.`);
      if (i === 1) convA = cidOf(page);
      await pause(2500); // stay well inside the free-tier rate limit
    }
    await storedSettled(convA, 10);
    const all = await stored(convA);
    const users = all.filter((m) => m.role === 'user');
    const replies = all.filter((m) => m.role === 'assistant');
    expect(users.map((m) => m.content)).toEqual(Array.from({ length: 10 }, (_, i) => `Question ${i + 1}: reply with only the number ${(i + 1) * 11}.`));
    expect(replies).toHaveLength(10);
    for (const r of replies) {
      expect(r.status).toBe('complete');
      expect(r.content.trim().length).toBeGreaterThan(0);
    }
    // alternating user / assistant, nothing lost or overwritten
    expect(all.map((m) => m.role)).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2 ? 'assistant' : 'user')));
    for (let i = 1; i <= 10; i++) expect(replies[i - 1].content).toContain(String(i * 11));
    // and every reply is still visible on screen
    const { positions } = await visibleOrder(page, Array.from({ length: 10 }, (_, i) => `Question ${i + 1}:`));
    expect(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]))).toBe(true);
    for (let i = 1; i <= 10; i++) await expect(page.locator('main').getByText(String(i * 11), { exact: false }).first()).toBeVisible();
  });

  test('2. three conversations, switching between them while replies arrive', async ({ page }) => {
    await signIn(page);
    // switching happens in the app (sidebar / New chat), as a user does: no page reloads
    await newChat(page);
    await send(page, 'Conversation B, first message: reply with only the word BRAVO.');
    convB = cidOf(page);
    await pause(2500);
    await newChat(page);
    await composer(page).fill('Conversation C, first message: write two sentences about the sea, then the word CHARLIE.');
    await composer(page).press('Enter');
    await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 });
    convC = cidOf(page);
    // switch away immediately, while C's reply is still on its way, then to B, then to A
    await openInSidebar(page, convB, 'Conversation B, first message');
    await openInSidebar(page, convA, 'Question 10:');
    // A must not show C's reply
    await storedSettled(convC, 1);
    await expect(page.locator('main').getByText('CHARLIE', { exact: false })).toHaveCount(0);
    await pause(2500);
    await openInSidebar(page, convB, 'Conversation B, first message');
    await send(page, 'Conversation B, second message: reply with only the word BRAVO2.');
    await storedSettled(convB, 2);

    const b = await stored(convB);
    const c = await stored(convC);
    expect(b.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(b[1].content).toContain('BRAVO');
    expect(b[3].content).toContain('BRAVO2');
    expect(c.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(c[1].content).toContain('CHARLIE');
    // no reply landed in the wrong conversation
    expect(b.some((m) => m.content.includes('CHARLIE'))).toBe(false);
    expect((await stored(convA)).length).toBe(20);
    // C still shows its reply after switching back
    await openInSidebar(page, convC, 'CHARLIE');
  });

  test('3. a page refresh keeps the whole history', async ({ page }) => {
    await signIn(page);
    await page.goto(`/c/${convA}`);
    await expect(page.getByText('Question 10:', { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Question 10:', { exact: false })).toBeVisible({ timeout: 30_000 });
    for (let i = 1; i <= 10; i++) await expect(page.locator('main').getByText(String(i * 11), { exact: false }).first()).toBeVisible();
    await page.goto(`/c/${convB}`);
    await page.reload();
    await expect(page.locator('main').getByText('BRAVO2', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  });

  test('4. closing and reopening the browser keeps the whole history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));
    try {
      let ctx = await webkit.launchPersistentContext(dir, { baseURL: 'http://127.0.0.1:5173' });
      let page = ctx.pages()[0] ?? (await ctx.newPage());
      await signIn(page);
      await page.goto(`/c/${convA}`);
      await expect(page.getByText('Question 10:', { exact: false })).toBeVisible();
      await ctx.close();
      // a fresh browser process on the same profile: still signed in, history intact
      ctx = await webkit.launchPersistentContext(dir, { baseURL: 'http://127.0.0.1:5173' });
      page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(`/c/${convA}`);
      await expect(page.getByText('Question 10:', { exact: false })).toBeVisible({ timeout: 30_000 });
      for (let i = 1; i <= 10; i++) await expect(page.locator('main').getByText(String(i * 11), { exact: false }).first()).toBeVisible();
      await page.goto(`/c/${convC}`);
      await expect(page.locator('main').getByText('CHARLIE', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await ctx.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('5. an AI failure keeps the user message, and Retry does not duplicate it', async ({ page }) => {
    await signIn(page);
    await page.goto(`/c/${convB}`);
    await expect(page.getByText('BRAVO2', { exact: false }).first()).toBeVisible();
    // the next /api/chat call fails as if the provider were down
    let failed = 0;
    await page.route('**/api/chat', async (route) => {
      if (failed++ === 0) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'provider_error', message: 'The AI service is unavailable.' } }) });
      } else await route.continue();
    });
    const text = 'Conversation B, third message: reply with only the word RETRIED.';
    await composer(page).fill(text);
    await composer(page).press('Enter');
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible({ timeout: 30_000 });
    // the user message is stored even though the reply failed
    await expect.poll(async () => (await stored(convB)).filter((m) => m.content === text).length).toBe(1);
    await pause(2500);
    await retry.click();
    await replyDone(page);
    await expect.poll(async () => (await stored(convB)).filter((m) => m.role === 'assistant' && m.status === 'complete').length, { timeout: 60_000 }).toBe(3);
    const b = await stored(convB);
    expect(b.filter((m) => m.content === text)).toHaveLength(1);
    expect(b.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(b[5].content).toContain('RETRIED');
    expect(b.some((m) => m.status === 'error')).toBe(false);
    await page.reload();
    await expect(page.locator('main').getByText('RETRIED', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  });

  test('6. a network interruption mid-reply keeps the user message and the partial reply', async ({ page, context }) => {
    await signIn(page);
    await page.goto(`/c/${convC}`);
    await expect(page.getByText('CHARLIE', { exact: false }).first()).toBeVisible();
    await pause(2500);
    const text = 'Conversation C, second message: list 60 numbered facts about rivers, one short line each.';
    await composer(page).fill(text);
    await composer(page).press('Enter');
    // wait until part of the reply has streamed in, then cut the connection
    await expect(page.locator('main').getByText(/^3\.|^\s*3\./m).first()).toBeVisible({ timeout: 60_000 }).catch(() => undefined);
    await context.setOffline(true);
    await pause(5000);
    await context.setOffline(false);
    await expect.poll(async () => (await stored(convC)).filter((m) => m.role === 'assistant' && m.status !== 'processing').length, { timeout: 90_000 }).toBe(2);
    const c = await stored(convC);
    expect(c.filter((m) => m.content === text)).toHaveLength(1);
    const reply = c.at(-1)!;
    expect(reply.role).toBe('assistant');
    // the server either finished it, or stored what was generated before the browser went away
    expect(['complete', 'stopped']).toContain(reply.status);
    expect(reply.content.length).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('main').getByText(reply.content.slice(0, 20), { exact: false }).first()).toBeVisible();
  });

  test('7. rapid messaging: a double send creates one message, and quick follow-ups all keep their replies', async ({ page }) => {
    await signIn(page);
    await newChat(page);
    const first = 'Rapid 1: reply with only the word ONE.';
    await composer(page).fill(first);
    await composer(page).press('Enter');
    await composer(page).press('Enter');
    await page.getByRole('button', { name: 'Send message' }).click({ timeout: 1000 }).catch(() => undefined);
    await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 });
    const cid = cidOf(page);
    await storedSettled(cid, 1);
    await replyDone(page);
    // while a reply is generating, Enter must not start a second one
    await composer(page).fill('Rapid 2: write 30 numbered sentences about clocks, then the word TWO.');
    await composer(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({ timeout: 30_000 });
    await composer(page).fill('Rapid 3: reply with only the word THREE.');
    await composer(page).press('Enter'); // ignored while "Rapid 2" is generating: the text stays in the box
    await expect(composer(page)).toHaveValue('Rapid 3: reply with only the word THREE.');
    await replyDone(page);
    await composer(page).press('Enter'); // now "Rapid 3" is sent
    await expect(composer(page)).toHaveValue('', { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({ timeout: 30_000 }).catch(() => undefined);
    await replyDone(page);
    await storedSettled(cid, 3);
    const all = await stored(cid);
    expect(all.filter((m) => m.content === first)).toHaveLength(1);
    expect(all.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(all[1].content).toContain('ONE');
    expect(all[3].content).toContain('TWO');
    expect(all[5].content).toContain('THREE');
    expect(all.filter((m) => m.role === 'assistant').every((m) => m.status === 'complete')).toBe(true);
  });

  test('8. switching the AI model mid-conversation keeps the history', async ({ page }) => {
    await signIn(page);
    await page.goto(`/c/${convB}`);
    await expect(page.getByText('RETRIED', { exact: false }).first()).toBeVisible();
    const before = await stored(convB);
    // pick a free OpenRouter model in the model picker
    await page.getByRole('button', { name: /Gemini 3\.5 Flash/ }).first().click();
    const other = page.getByRole('button', { name: /Nemotron 3 Ultra \(free\).*via OpenRouter/ }).first();
    await expect(other).toBeVisible();
    const name = 'Nemotron 3 Ultra';
    await other.click();
    await expect(page.getByRole('button', { name: /Nemotron 3 Ultra/ }).first()).toBeVisible();
    await pause(2500);
    await send(page, 'Conversation B, fourth message: reply with only the word SWITCHED.');
    await storedSettled(convB, 4);
    const after = await stored(convB);
    expect(after.slice(0, before.length).map((m) => [m.id, m.content])).toEqual(before.map((m) => [m.id, m.content]));
    const last = after.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.content.length).toBeGreaterThan(0);
    expect(last.model).not.toContain('gemini');
    test.info().annotations.push({ type: 'model', description: `${name} -> ${last.model}` });
    expect(last.model).toContain('nemotron');
  });

  test('9. streaming: the reply is "processing" in Firestore while it streams, then stored in full', async ({ page }) => {
    await signIn(page);
    await page.goto(`/c/${convC}`);
    await pause(2500);
    await composer(page).fill('Conversation C, third message: write 25 numbered short sentences about mountains.');
    await composer(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({ timeout: 30_000 });
    let sawProcessing = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !sawProcessing) {
      sawProcessing = (await stored(convC)).some((m) => m.role === 'assistant' && m.status === 'processing');
      if (!sawProcessing) await pause(150);
      if (!(await page.getByRole('button', { name: 'Stop generating' }).isVisible())) break;
    }
    await replyDone(page);
    await storedSettled(convC, 3);
    const reply = (await stored(convC)).at(-1)!;
    expect(reply.status).toBe('complete');
    const shown = await page.locator('main').innerText();
    // the stored copy is the full reply the user saw (compare a distinctive tail fragment)
    const tail = reply.content.trim().split('\n').at(-1)!.replace(/[*_`#]/g, '').trim().slice(-22).trim();
    expect(shown).toContain(tail);
    test.info().annotations.push({ type: 'processing-placeholder-observed', description: String(sawProcessing) });
  });

  test('10. deleting a conversation removes only that conversation', async ({ page }) => {
    await signIn(page);
    await page.goto(`/c/${convC}`);
    await expect(page.getByText('CHARLIE', { exact: false }).first()).toBeVisible();
    const link = page.locator(`a[href="/c/${convC}"]`).first();
    await link.hover();
    await link.locator('xpath=..').getByRole('button', { name: 'Conversation options' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(async () => (await stored(convC)).length, { timeout: 30_000 }).toBe(0);
    await expect.poll(() => conversationExists(convC)).toBe(false);
    expect((await stored(convA)).length).toBe(20);
    expect((await stored(convB)).length).toBe(8);
    await expect(page.locator(`a[href="/c/${convC}"]`)).toHaveCount(0);
  });
});

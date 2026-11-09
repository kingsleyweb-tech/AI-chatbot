import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devices, expect, test, type Page } from '@playwright/test';

// Voice input, Voice Mode and translation, end to end: Chromium with a fake microphone (a test
// tone), the dev server with the scripted AI and scripted Cloudflare speech models
// (E2E_FAKE_AI=1: every recording "says" a fixed sentence; no request reaches Cloudflare),
// Auth and Firestore emulators. Setup: see playwright.emulator.config.ts.
const EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Passw0rd!e2e';
const SAID = 'Hello Atlas, what is the capital of France?';

/**
 * The fake microphone plays this file in a loop: 1.6 s of a voiced, speech-like sound, then 6 s of
 * near-silence, so the real voice activity detection in Voice Mode hears one turn and its end.
 */
function speechLikeWav(): string {
  const rate = 16_000;
  const n = rate * 7.6;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const voiced = t < 1.6 ? 0.25 * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(4 * Math.PI * 140 * t) + 0.25 * Math.sin(6 * Math.PI * 140 * t)) : 0;
    pcm[i] = Math.round((voiced + 0.0008 * (Math.random() * 2 - 1)) * 32767);
  }
  const buf = Buffer.alloc(44 + pcm.byteLength);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.byteLength, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  const file = join(tmpdir(), 'atlas-e2e-speech.wav');
  writeFileSync(file, buf);
  return file;
}
const SPEECH_WAV = speechLikeWav();

test.use({
  ...devices['Desktop Edge'],
  channel: 'msedge',
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${SPEECH_WAV}`, '--autoplay-policy=no-user-gesture-required'],
  },
});

const composer = (page: Page) => page.getByLabel('Message', { exact: true });

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Gemini|free/i }).first()).toBeVisible({ timeout: 30_000 });
}

test('the microphone records, Whisper transcribes, and the text waits in the box for review', async ({ page }) => {
  await signIn(page);
  await composer(page).fill('Question:');
  await page.getByRole('button', { name: 'Voice input' }).click();
  await expect(page.getByText('Listening… tap the mic to finish')).toBeVisible();
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  // inserted after what was already typed, not sent
  await expect(composer(page)).toHaveValue(`Question: ${SAID}`, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('a recording can be cancelled without sending anything', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Voice input' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Listening… tap the mic to finish')).toBeHidden();
  await expect(composer(page)).toHaveValue('');
});

test('Voice Mode: hears a turn by itself, sends it, answers, listens again, saves it; End closes it', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Voice Mode: talk with Atlas AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Voice Mode' });
  await expect(dialog).toBeVisible();
  // no taps: the detector hears the speech-like sound, waits for the pause and sends the turn
  await expect(dialog.getByText(SAID)).toBeVisible({ timeout: 30_000 });
  // the reply is spoken, then it listens again on its own
  await expect(dialog.getByText(/Speaking/)).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText('Listening…')).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText('Microphone on')).toBeVisible();
  // mute and unmute
  await dialog.getByRole('button', { name: 'Mute' }).click();
  await expect(dialog.getByText('Microphone muted').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Unmute' }).click();
  // the turn went through the normal chat pipeline: a conversation exists with the message
  await expect(page).toHaveURL(/\/c\//, { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'End', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(SAID).first()).toBeVisible();
  await expect(page.locator('[data-generation-indicator]')).toHaveCount(0, { timeout: 60_000 });
});

test('Translate with Cloudflare shows a translation under the reply without changing it', async ({ page }) => {
  await signIn(page);
  await composer(page).fill('Say hello in one short sentence.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({ timeout: 90_000 });
  await expect(page.locator('[data-generation-indicator]')).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Message options' }).last().click();
  await page.getByRole('menuitem', { name: 'Translate with Cloudflare' }).click();
  const dialog = page.getByRole('dialog', { name: 'Translate' });
  await dialog.locator('select').first().selectOption('french');
  await dialog.locator('select').nth(1).selectOption('english');
  await dialog.getByRole('button', { name: 'Translate' }).click();
  await expect(page.getByText('Translated from English to French')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/\[french\]/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Hide translation' }).click();
  await expect(page.getByText('Translated from English to French')).toBeHidden();
});

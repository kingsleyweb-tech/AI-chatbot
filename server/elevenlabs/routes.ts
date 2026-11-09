/**
 * ElevenLabs request handling for /api/speech (kept in one place so api/speech.ts stays small).
 * Every caller is already a signed-in, approved user (requireAllowedUser); administrator actions
 * check `ctx.admin` again here.
 */
import { z } from 'zod';
import type { Ctx } from '../access.js';
import {
  ELEVEN_DEFAULT_VOICE,
  ELEVEN_DESIGN_ESTIMATE,
  ELEVEN_DESIGN_MODEL,
  ELEVEN_DESIGN_TEXT_MAX,
  ELEVEN_DESIGN_TEXT_MIN,
  ELEVEN_DESIGNED_VOICES_MAX,
  ELEVEN_MAX_CHARS,
  ELEVEN_MAXIMA,
  ELEVEN_MODELS,
  ELEVEN_PREVIEW_TEXT,
  ELEVEN_SPEED_MAX,
  ELEVEN_SPEED_MIN,
  elevenModel,
} from '../config/elevenlabs.js';
import type { Firestore } from '../firestore.js';
import { HttpError, json } from '../http.js';
import { ProviderError } from '../providers/types.js';
import { capabilityList, detectCapabilities, noteFeatureResult, resetCapabilityState, voiceDesignAllowed } from './capabilities.js';
import { elevenLabsConfigured, isPlanRefusal } from './client.js';
import { CONSENT_STATEMENT, designVoice, listVoices, removeDesignedVoice, saveDesignedVoice, speakStream, voiceAllowed } from './speech.js';
import { creditsLeft, elevenUsage, loadElevenSettings, recentElevenRequests, reserveCredits, saveElevenSettings } from './usage.js';

const voiceId = z.string().regex(/^[A-Za-z0-9]{8,40}$/);

/** Extra fields of the `speak` action used by ElevenLabs. */
export const elevenSpeakFields = {
  provider: z.enum(['cloudflare', 'elevenlabs']).optional(),
  voiceId: voiceId.optional(),
  model: z.string().max(60).optional(),
  speed: z.number().min(ELEVEN_SPEED_MIN).max(ELEVEN_SPEED_MAX).optional(),
  preview: z.boolean().optional(),
  previousText: z.string().max(1_000).optional(),
  nextText: z.string().max(1_000).optional(),
};

export const elevenAdminBody = z.object({
  action: z.literal('elevenAdmin'),
  op: z.enum(['status', 'refresh', 'settings', 'design', 'save', 'remove']),
  settings: z
    .object({
      enabled: z.boolean().optional(),
      appDailyCredits: z.number().int().min(0).max(ELEVEN_MAXIMA.appDailyCredits).optional(),
      appMonthlyCredits: z.number().int().min(0).max(ELEVEN_MAXIMA.appMonthlyCredits).optional(),
      userDailyCredits: z.number().int().min(0).max(ELEVEN_MAXIMA.userDailyCredits).optional(),
      defaultModel: z.enum(ELEVEN_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
    })
    .optional(),
  description: z.string().trim().min(20).max(1_000).optional(),
  text: z.string().trim().min(ELEVEN_DESIGN_TEXT_MIN).max(ELEVEN_DESIGN_TEXT_MAX).optional(),
  generatedVoiceId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/).optional(),
  name: z.string().trim().min(2).max(40).optional(),
  consent: z.literal(true).optional(),
  voiceId: voiceId.optional(),
});

type SpeakBody = { text: string } & { [K in keyof typeof elevenSpeakFields]?: z.infer<(typeof elevenSpeakFields)[K]> };
type AdminBody = z.infer<typeof elevenAdminBody>;

function providerFail(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof ProviderError) throw new HttpError(err.status >= 500 ? 502 : err.status, `eleven_${err.code}`, err.message);
  throw err;
}

/* ------------------------------ GET (what the person may use) ------------------------------ */

export async function elevenGet(db: Firestore, uid: string, admin: boolean) {
  if (!elevenLabsConfigured()) return { configured: false as const };
  const settings = await loadElevenSettings(db);
  let left: number;
  try {
    left = creditsLeft(settings, await elevenUsage(db, uid), uid);
  } catch {
    left = 0;
  }
  const model = elevenModel(settings.defaultModel);
  return {
    configured: true as const,
    enabled: settings.enabled,
    available: settings.enabled && left >= 20,
    creditsLeft: Math.floor(left),
    charactersLeft: Math.floor(left / model.creditsPerChar),
    defaultModel: settings.defaultModel,
    defaultVoice: ELEVEN_DEFAULT_VOICE,
    models: ELEVEN_MODELS.map(({ id, label, description, creditsPerChar }) => ({ id, label, description, creditsPerChar })),
    voices: settings.enabled || admin ? await listVoices(db) : [],
    speed: { min: ELEVEN_SPEED_MIN, max: ELEVEN_SPEED_MAX },
  };
}

/* ------------------------------ speech ------------------------------ */

/** Requests one person may have running at once (Voice Mode fetches the next part while one plays). */
const MAX_CONCURRENT = 3;
const running = new Map<string, number>();
export function resetElevenRoutes() {
  running.clear();
  resetCapabilityState();
}

export async function elevenSpeak(ctx: Ctx, b: SpeakBody, signal: AbortSignal, later: (p: Promise<unknown>) => void): Promise<Response> {
  const { db, user } = ctx;
  if (!elevenLabsConfigured()) throw new HttpError(503, 'eleven_unconfigured', 'The ElevenLabs voice is not set up on this server.');
  const settings = await loadElevenSettings(db);
  if (!settings.enabled) throw new HttpError(403, 'eleven_disabled', 'The ElevenLabs voice is turned off by the administrator.');
  const vid = b.voiceId ?? ELEVEN_DEFAULT_VOICE;
  if (!(await voiceAllowed(db, vid))) throw new HttpError(400, 'eleven_voice', 'That voice is not available in Atlas AI.');
  const model = elevenModel(b.model ?? settings.defaultModel);
  const text = b.preview ? ELEVEN_PREVIEW_TEXT : b.text.replace(/\s+/g, ' ').trim().slice(0, ELEVEN_MAX_CHARS);
  if (!text) throw new HttpError(400, 'bad_request', 'Invalid request.');
  if ((running.get(user.uid) ?? 0) >= MAX_CONCURRENT) throw new HttpError(429, 'eleven_busy', 'Too many voice requests at once. Please wait a moment.');

  const estimate = Math.ceil(text.length * model.creditsPerChar);
  const r = await reserveCredits(db, user.uid, estimate);
  if (!r.ok) throw new HttpError(r.reason === 'unavailable' ? 503 : r.reason === 'disabled' ? 403 : r.reason === 'plan_credits' ? 402 : 429, `eleven_${r.reason}`, r.message);

  running.set(user.uid, (running.get(user.uid) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(safety);
    const n = (running.get(user.uid) ?? 1) - 1;
    if (n > 0) running.set(user.uid, n);
    else running.delete(user.uid);
  };
  // a stream nobody reads to the end (and nobody cancels) must not block the person for good
  const safety = setTimeout(release, 60_000);
  (safety as { unref?: () => void }).unref?.();
  const t0 = Date.now();
  const entry = { uid: user.uid, type: b.preview ? ('preview' as const) : ('tts' as const), model: model.id, voiceId: vid, characters: text.length };
  let out;
  try {
    out = await speakStream(text, { voiceId: vid, modelId: model.id, speed: b.speed, previousText: b.previousText, nextText: b.nextText }, signal);
  } catch (err) {
    release();
    await r.settle(0, { ...entry, ok: false, error: err instanceof ProviderError ? err.code : 'aborted', ms: Date.now() - t0 });
    providerFail(err);
  }
  // ElevenLabs reports the exact cost in the response headers, before the audio: record it without
  // delaying the first audio (the write finishes in the background).
  later(r.settle(out.credits ?? estimate, { ...entry, ok: true, ms: Date.now() - t0, requestId: out.requestId }));
  const reader = out.stream.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'private, max-age=86400',
      'x-voice-provider': 'elevenlabs',
    },
  });
}

/* ------------------------------ administrators ------------------------------ */

export async function elevenAdmin(ctx: Ctx, b: AdminBody, signal: AbortSignal): Promise<Response> {
  const { db, user } = ctx;
  if (!ctx.admin) throw new HttpError(403, 'admin_only', 'Only administrators can change the ElevenLabs settings.');
  const by = user.email ?? user.uid;

  if (b.op === 'status' || b.op === 'refresh') {
    const [settings, usage, recent, voices, detected] = await Promise.all([
      loadElevenSettings(db, true),
      elevenUsage(db, user.uid).catch(() => null),
      recentElevenRequests(db, 30).catch(() => []),
      listVoices(db),
      detectCapabilities(db, { force: b.op === 'refresh' }),
    ]);
    return json(
      {
        configured: elevenLabsConfigured(),
        settings,
        usage,
        recent,
        voices,
        consentStatement: CONSENT_STATEMENT,
        designModel: ELEVEN_DESIGN_MODEL,
        capabilities: capabilityList(detected),
        plan: detected.plan,
        checkedAt: detected.checkedAt || null,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  if (b.op === 'settings') {
    if (!b.settings) throw new HttpError(400, 'bad_request', 'Invalid request.');
    return json({ settings: await saveElevenSettings(db, b.settings, by) });
  }

  if (!elevenLabsConfigured()) throw new HttpError(503, 'eleven_unconfigured', 'ElevenLabs is not set up on this server.');

  if (b.op === 'design') {
    if (!b.description || !b.text) throw new HttpError(400, 'bad_request', `Describe the voice (at least 20 characters) and give a sample text of ${ELEVEN_DESIGN_TEXT_MIN}–${ELEVEN_DESIGN_TEXT_MAX} characters.`);
    if (!voiceDesignAllowed(await detectCapabilities(db))) {
      throw new HttpError(402, 'eleven_needs_plan', 'Voice Design needs a paid ElevenLabs plan. After upgrading, press Check again.');
    }
    const r = await reserveCredits(db, user.uid, Math.max(b.text.length, ELEVEN_DESIGN_ESTIMATE), { personalCap: false });
    if (!r.ok) throw new HttpError(r.reason === 'unavailable' ? 503 : r.reason === 'disabled' ? 403 : r.reason === 'plan_credits' ? 402 : 429, `eleven_${r.reason}`, r.message);
    const t0 = Date.now();
    const entry = { uid: user.uid, type: 'design' as const, model: ELEVEN_DESIGN_MODEL, characters: b.text.length };
    try {
      const out = await designVoice(b.description, b.text, signal);
      await r.settle(out.credits ?? b.text.length, { ...entry, ok: true, ms: Date.now() - t0, requestId: out.requestId });
      await noteFeatureResult(db, 'voice_design', true);
      return json({ previews: out.previews, text: out.text, credits: out.credits, creditsEstimated: out.credits == null });
    } catch (err) {
      await r.settle(0, { ...entry, ok: false, error: err instanceof ProviderError ? err.code : 'aborted', ms: Date.now() - t0 });
      if (isPlanRefusal(err)) await noteFeatureResult(db, 'voice_design', false);
      providerFail(err);
    }
  }

  if (b.op === 'save') {
    if (b.consent !== true) throw new HttpError(400, 'consent_required', 'Confirm the voice statement before saving the voice.');
    if (!b.generatedVoiceId || !b.name || !b.description) throw new HttpError(400, 'bad_request', 'Invalid request.');
    const designed = (await listVoices(db)).filter((v) => v.source === 'designed').length;
    if (designed >= ELEVEN_DESIGNED_VOICES_MAX) throw new HttpError(409, 'eleven_voice_limit', `Atlas AI keeps at most ${ELEVEN_DESIGNED_VOICES_MAX} designed voices. Remove one first.`);
    try {
      const voice = await saveDesignedVoice(db, { generatedVoiceId: b.generatedVoiceId, name: b.name, description: b.description }, by, signal);
      return json({ voice });
    } catch (err) {
      providerFail(err);
    }
  }

  // remove
  if (!b.voiceId) throw new HttpError(400, 'bad_request', 'Invalid request.');
  return json(await removeDesignedVoice(db, b.voiceId, signal));
}

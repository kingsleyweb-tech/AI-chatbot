/**
 * ElevenLabs speech features (server-only):
 *  - streamed text-to-speech (MP3) in a chosen voice, model and speed
 *  - Voice Design (administrators): voices generated from a written description, never from a
 *    recording of a person, and saved only after the administrator confirms the consent statement
 *  - the voices Atlas AI offers: ElevenLabs' default voices plus voices saved through Voice Design
 */
import {
  ELEVEN_DESIGN_MODEL,
  ELEVEN_SPEED_MAX,
  ELEVEN_SPEED_MIN,
  ELEVEN_VOICES,
  elevenModel,
  type ElevenVoice,
} from '../config/elevenlabs.js';
import type { Firestore } from '../firestore.js';
import { trustedDb } from '../admin.js';
import { creditsOf, elevenLabs, mapElevenLabsError } from './client.js';

export interface SpeakOptions {
  voiceId: string;
  modelId: string;
  speed?: number;
  /** the text spoken just before / after this piece, for natural joins between parts of a long reply */
  previousText?: string;
  nextText?: string;
}

export interface SpeechStream {
  stream: ReadableStream<Uint8Array>;
  /** credits ElevenLabs reports for this request (null when the header is missing) */
  credits: number | null;
  requestId: string | null;
}

export const clampSpeed = (s: number | undefined) => Math.min(ELEVEN_SPEED_MAX, Math.max(ELEVEN_SPEED_MIN, Number.isFinite(s) ? (s as number) : 1));

/** Start streaming MP3 for `text`. Resolves once ElevenLabs accepted the request (headers received). */
export async function speakStream(text: string, o: SpeakOptions, signal?: AbortSignal): Promise<SpeechStream> {
  const model = elevenModel(o.modelId);
  try {
    const { data, rawResponse } = await elevenLabs()
      .textToSpeech.stream(
        o.voiceId,
        {
          text,
          modelId: model.id,
          outputFormat: 'mp3_44100_64',
          voiceSettings: { stability: 0.5, similarityBoost: 0.75, useSpeakerBoost: true, ...(model.speed ? { speed: clampSpeed(o.speed) } : {}) },
          ...(o.previousText ? { previousText: o.previousText.slice(-300) } : {}),
          ...(o.nextText ? { nextText: o.nextText.slice(0, 300) } : {}),
        },
        { abortSignal: signal },
      )
      .withRawResponse();
    return { stream: data, credits: creditsOf(rawResponse.headers), requestId: rawResponse.headers.get('request-id') };
  } catch (err) {
    throw mapElevenLabsError(err, signal);
  }
}

/* ------------------------------ voices ------------------------------ */

export const DESIGNED_VOICES = 'elevenlabsVoices';

interface DesignedVoiceDoc {
  name: string;
  description: string;
  createdAt: number;
  createdBy: string;
  consent: { statement: string; at: number; by: string };
  hidden?: boolean;
}

/** Voices Atlas AI offers: the default voices, then designed ones (newest first). */
export async function listVoices(userDb: Firestore): Promise<ElevenVoice[]> {
  let designed: ElevenVoice[] = [];
  try {
    const rows = await (await trustedDb(userDb)).list<DesignedVoiceDoc>(DESIGNED_VOICES, { orderBy: 'createdAt', direction: 'DESCENDING', limit: 50 });
    designed = rows.filter((r) => !r.data.hidden).map((r) => ({ id: r.id, name: r.data.name, description: r.data.description, source: 'designed' as const }));
  } catch {
    // unreadable: default voices only
  }
  return [...ELEVEN_VOICES, ...designed];
}

/** Only voices Atlas AI offers can be used (not any voice ID someone types in). */
export async function voiceAllowed(userDb: Firestore, voiceId: string): Promise<boolean> {
  if (ELEVEN_VOICES.some((v) => v.id === voiceId)) return true;
  return (await listVoices(userDb)).some((v) => v.id === voiceId);
}

/* ------------------------------ Voice Design ------------------------------ */

export interface DesignPreview {
  generatedVoiceId: string;
  audioBase64: string;
  mediaType: string;
  durationSecs: number;
}

/** Generate up to three preview voices from a description (costs credits; nothing is saved yet). */
export async function designVoice(description: string, text: string, signal?: AbortSignal): Promise<{ previews: DesignPreview[]; text: string; credits: number | null; requestId: string | null }> {
  try {
    const { data, rawResponse } = await elevenLabs()
      .textToVoice.design({ voiceDescription: description, modelId: ELEVEN_DESIGN_MODEL, text, outputFormat: 'mp3_44100_64' }, { abortSignal: signal, timeoutInSeconds: 60 })
      .withRawResponse();
    return {
      previews: data.previews.slice(0, 3).map((p) => ({ generatedVoiceId: p.generatedVoiceId, audioBase64: p.audioBase64, mediaType: p.mediaType || 'audio/mpeg', durationSecs: p.durationSecs })),
      text: data.text,
      credits: creditsOf(rawResponse.headers),
      requestId: rawResponse.headers.get('request-id'),
    };
  } catch (err) {
    throw mapElevenLabsError(err, signal);
  }
}

export const CONSENT_STATEMENT =
  'This voice was generated from a written description. It is not a copy of a real person’s voice, and Atlas AI has the right to use it.';

/** Save a designed preview as a voice in the ElevenLabs account and offer it in Atlas AI. */
export async function saveDesignedVoice(
  userDb: Firestore,
  v: { generatedVoiceId: string; name: string; description: string },
  by: string,
  signal?: AbortSignal,
): Promise<ElevenVoice> {
  let voiceId: string;
  try {
    const voice = await elevenLabs().textToVoice.create(
      { voiceName: v.name, voiceDescription: v.description, generatedVoiceId: v.generatedVoiceId, labels: { app: 'atlas-ai' } },
      { abortSignal: signal },
    );
    voiceId = voice.voiceId;
  } catch (err) {
    throw mapElevenLabsError(err, signal);
  }
  const now = Date.now();
  await (await trustedDb(userDb)).set(`${DESIGNED_VOICES}/${voiceId}`, {
    name: v.name,
    description: v.description,
    createdAt: now,
    createdBy: by,
    consent: { statement: CONSENT_STATEMENT, at: now, by },
  } satisfies DesignedVoiceDoc);
  return { id: voiceId, name: v.name, description: v.description, source: 'designed' };
}

/**
 * Remove a designed voice: deleted from the ElevenLabs account when the key allows it, and always
 * hidden from Atlas AI. Returns whether ElevenLabs deleted it too.
 */
export async function removeDesignedVoice(userDb: Firestore, voiceId: string, signal?: AbortSignal): Promise<{ deletedAtElevenLabs: boolean }> {
  const db = await trustedDb(userDb);
  const doc = await db.get<DesignedVoiceDoc>(`${DESIGNED_VOICES}/${voiceId}`);
  if (!doc) return { deletedAtElevenLabs: false };
  let deletedAtElevenLabs = false;
  try {
    await elevenLabs().voices.delete(voiceId, { abortSignal: signal });
    deletedAtElevenLabs = true;
  } catch {
    // the key may lack voices_write: the voice stays in the ElevenLabs account but is no longer offered
  }
  if (deletedAtElevenLabs) await db.delete(`${DESIGNED_VOICES}/${voiceId}`);
  else await db.set(`${DESIGNED_VOICES}/${voiceId}`, { hidden: true }, true);
  return { deletedAtElevenLabs };
}

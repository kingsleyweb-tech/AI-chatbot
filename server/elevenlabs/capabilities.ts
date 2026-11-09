/**
 * What the ElevenLabs account can do right now, detected instead of hardcoded, so upgrading the plan
 * or replacing the key turns features on without a code change.
 *
 * Signals (none of them spends credits):
 *  1. GET /v1/user/subscription: the plan tier and credit balance. Needs the key's user_read
 *     permission; with it, a paid plan unlocks Voice Design immediately.
 *  2. GET /v1/voices (one voice): tells whether the key has voices_read.
 *  3. The answers to real requests: a Voice Design request that ElevenLabs refuses for the plan is
 *     remembered (a refusal costs nothing), and a successful one confirms the feature. A remembered
 *     refusal expires after a day, or at once when an administrator presses "Check again".
 * ElevenLabs checks the request body before the plan, so a plan feature cannot be probed with an
 * empty request; that is why the plan read (1) is the preferred signal.
 *
 * Stored in config/voiceCapabilities (server identity only; clients cannot read config/*). Only
 * tier names, numbers, yes/no flags and times are kept: never the key or provider messages.
 */
import { trustedDb } from '../admin.js';
import type { Firestore } from '../firestore.js';
import { elevenGetJson, elevenLabsConfigured } from './client.js';

export const CAPABILITIES_PATH = 'config/voiceCapabilities';
/** How long a detection result is reused before the free checks run again. */
export const DETECT_TTL_MS = 60 * 60 * 1000;
/** How long a plan refusal blocks new attempts before Atlas AI lets one through again. */
export const REFUSAL_TTL_MS = 24 * 60 * 60 * 1000;

export type CapabilityStatus = 'available' | 'unknown' | 'needs_plan' | 'missing_permission' | 'not_built' | 'needs_hosting' | 'not_needed';
export interface Capability {
  id: string;
  label: string;
  status: CapabilityStatus;
  note?: string;
}

export interface PlanInfo {
  tier: string;
  /** credits used this billing period, and the period's allowance */
  used: number;
  limit: number;
  resetsAt: number | null;
  status: string | null;
}

interface StoredState {
  checkedAt: number;
  /** null = the key may not read it */
  plan: PlanInfo | null;
  voicesRead: boolean | null;
  /** feature id -> last time ElevenLabs refused it for the plan */
  refused: Record<string, number>;
  /** feature id -> last time it worked */
  confirmed: Record<string, number>;
}

const EMPTY: StoredState = { checkedAt: 0, plan: null, voicesRead: null, refused: {}, confirmed: {} };
let cache: StoredState | null = null;

export function resetCapabilityState() {
  cache = null;
}

/** 'free' | 'mid' (Starter, Creator) | 'pro' (Pro and above), from ElevenLabs' tier names. */
export function planLevel(tier: string | null | undefined): 'free' | 'mid' | 'pro' | null {
  if (!tier) return null;
  const t = tier.toLowerCase();
  if (t.startsWith('free')) return 'free';
  if (t.startsWith('starter') || t.startsWith('creator')) return 'mid';
  return 'pro';
}

function sanitize(raw: unknown): StoredState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredState>;
  const times = (o: unknown) =>
    Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => /^[a-z_]{2,30}$/.test(k) && typeof v === 'number')) as Record<string, number>;
  const p = r.plan as Partial<PlanInfo> | null | undefined;
  return {
    checkedAt: typeof r.checkedAt === 'number' ? r.checkedAt : 0,
    plan:
      p && typeof p.tier === 'string'
        ? { tier: p.tier, used: Number(p.used) || 0, limit: Number(p.limit) || 0, resetsAt: typeof p.resetsAt === 'number' ? p.resetsAt : null, status: typeof p.status === 'string' ? p.status : null }
        : null,
    voicesRead: typeof r.voicesRead === 'boolean' ? r.voicesRead : null,
    refused: times(r.refused),
    confirmed: times(r.confirmed),
  };
}

async function load(userDb: Firestore): Promise<StoredState> {
  if (cache) return cache;
  try {
    cache = sanitize((await (await trustedDb(userDb)).get(CAPABILITIES_PATH))?.data);
  } catch {
    cache = { ...EMPTY, refused: {}, confirmed: {} };
  }
  return cache;
}

async function save(userDb: Firestore, s: StoredState) {
  cache = s;
  try {
    await (await trustedDb(userDb)).set(CAPABILITIES_PATH, s);
  } catch {
    // kept in memory; the next detection writes it again
  }
}

class CheckFailed extends Error {}

/** 401 means the key lacks the permission (not a broken key: speech still works with it). */
async function readPlan(): Promise<PlanInfo | null> {
  const { status, body } = await elevenGetJson('/v1/user/subscription');
  if (status === 401) return null;
  const b = (body ?? {}) as Record<string, unknown>;
  if (status !== 200 || typeof b.tier !== 'string') throw new CheckFailed(String(status));
  return {
    tier: b.tier.slice(0, 40),
    used: Number(b.character_count) || 0,
    limit: Number(b.character_limit) || 0,
    resetsAt: typeof b.next_character_count_reset_unix === 'number' ? b.next_character_count_reset_unix * 1000 : null,
    status: typeof b.status === 'string' ? b.status.slice(0, 40) : null,
  };
}

async function readVoicesPermission(): Promise<boolean> {
  const { status } = await elevenGetJson('/v2/voices?page_size=1');
  if (status === 401) return false;
  if (status === 200) return true;
  throw new CheckFailed(String(status));
}

/**
 * Run the free checks when the stored result is older than DETECT_TTL_MS (or `force`).
 * A failed check (network, ElevenLabs down) keeps the previous answer instead of guessing.
 */
export async function detectCapabilities(userDb: Firestore, opts: { force?: boolean; now?: number } = {}): Promise<StoredState> {
  const now = opts.now ?? Date.now();
  const s = await load(userDb);
  if (!elevenLabsConfigured()) return s;
  if (!opts.force && now - s.checkedAt < DETECT_TTL_MS) return s;
  const [plan, voices] = await Promise.allSettled([readPlan(), readVoicesPermission()]);
  const next: StoredState = {
    ...s,
    checkedAt: now,
    plan: plan.status === 'fulfilled' ? plan.value : s.plan,
    voicesRead: voices.status === 'fulfilled' ? voices.value : s.voicesRead,
    refused: { ...s.refused },
    confirmed: { ...s.confirmed },
  };
  // a plan change makes earlier refusals meaningless
  if (planLevel(next.plan?.tier) !== planLevel(s.plan?.tier) && next.plan) next.refused = {};
  // "Check again": let the next real attempt through
  if (opts.force) next.refused = {};
  await save(userDb, next);
  return next;
}

/** Remember what a real request showed (refused for the plan, or worked). */
export async function noteFeatureResult(userDb: Firestore, feature: string, ok: boolean, now = Date.now()) {
  const s = await load(userDb);
  const next = { ...s, refused: { ...s.refused }, confirmed: { ...s.confirmed } };
  if (ok) {
    next.confirmed[feature] = now;
    delete next.refused[feature];
  } else {
    next.refused[feature] = now;
    delete next.confirmed[feature];
  }
  await save(userDb, next);
}

/** Voice Design status from the plan (when readable), otherwise from the last real answer. */
function voiceDesign(s: StoredState, now: number): Capability {
  const label = 'Voice Design (from a description)';
  const refusedAt = s.refused.voice_design;
  const refusedRecently = refusedAt != null && now - refusedAt < REFUSAL_TTL_MS;
  const level = planLevel(s.plan?.tier);
  if (level === 'free') return { id: 'voice_design', label, status: 'needs_plan', note: 'The account is on the free plan; creating voices through the API needs a paid plan. It turns on by itself after the upgrade.' };
  if (level && !refusedRecently) return { id: 'voice_design', label, status: 'available', note: `Included in the ${s.plan!.tier} plan.` };
  if (refusedRecently) {
    return {
      id: 'voice_design',
      label,
      status: 'needs_plan',
      note: `ElevenLabs refused it for the plan on ${new Date(refusedAt).toISOString().slice(0, 10)}. After upgrading, press Check again (or wait a day) and it turns on by itself.`,
    };
  }
  if (s.confirmed.voice_design) return { id: 'voice_design', label, status: 'available', note: 'Worked on the last attempt.' };
  return { id: 'voice_design', label, status: 'unknown', note: 'The plan cannot be read with this key, so the first attempt finds out. A refusal costs nothing.' };
}

/** The capability list shown to administrators, derived from the detected state. */
export function capabilityList(s: StoredState, now = Date.now()): Capability[] {
  const level = planLevel(s.plan?.tier);
  return [
    { id: 'tts', label: 'Text-to-speech (streamed)', status: 'available' },
    voiceDesign(s, now),
    s.voicesRead === true
      ? { id: 'voice_list', label: 'Read the account’s voice library', status: 'available', note: 'The key may read the voice library.' }
      : s.voicesRead === false
        ? { id: 'voice_list', label: 'Read the account’s voice library', status: 'missing_permission', note: 'The key needs the Voices (read) permission; Atlas AI offers ElevenLabs’ default voices and voices saved here.' }
        : { id: 'voice_list', label: 'Read the account’s voice library', status: 'unknown', note: 'Not checked yet.' },
    s.plan
      ? { id: 'subscription', label: 'Plan and credit balance', status: 'available', note: `${s.plan.tier} plan: ${s.plan.used.toLocaleString('en')} of ${s.plan.limit.toLocaleString('en')} credits used this period.` }
      : { id: 'subscription', label: 'Plan and credit balance', status: 'missing_permission', note: 'The key needs the User (read) permission. With it, Atlas AI reads the plan and turns paid features on by itself.' },
    { id: 'speech_engine', label: 'Speech Engine (ElevenLabs-run conversations)', status: 'needs_hosting', note: 'Needs an always-on WebSocket server (not possible on Vercel functions) and the convai permissions, on any plan.' },
    level === 'pro'
      ? { id: 'image_video', label: 'Image and video generation', status: 'not_built', note: 'The plan includes it, but Atlas AI does not have this feature yet; it needs building first.' }
      : { id: 'image_video', label: 'Image and video generation', status: 'needs_plan', note: level ? `Not in the ${s.plan!.tier} plan (Pro plan or above).` : 'ElevenLabs answers 402: Pro plan or above.' },
    { id: 'webhooks', label: 'Webhooks', status: 'not_needed', note: 'Only image/video jobs use them; speech is returned directly.' },
  ];
}

/** Whether a Voice Design request may be sent now (false only while a plan refusal is fresh or the plan is free). */
export function voiceDesignAllowed(s: StoredState, now = Date.now()): boolean {
  const st = voiceDesign(s, now).status;
  return st === 'available' || st === 'unknown';
}

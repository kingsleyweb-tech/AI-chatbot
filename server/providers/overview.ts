/**
 * Administrator view of the AI provider accounts (Gemini projects A/B, Cloudflare accounts A/B).
 *
 * Read-only, administrators only (api/admin.ts). It reports labels ("A", "B"), models, today's
 * counters, cooldowns and recent events. It never contains an API key, a token, an account id or
 * any request text.
 */
import { GEMINI_FREE_TIER } from '../billing/policy.js';
import { cloudflareAccountIds, cloudflareAccountUsable, cloudflareDailyLimitActive } from '../cloudflare/client.js';
import { accountNeurons, usagePath, utcDay } from '../cloudflare/budget.js';
import { loadLimits } from '../config/limits.js';
import { pacificDay, rpmGuard } from '../config/providerLimits.js';
import type { Firestore } from '../firestore.js';
import * as H from './accountHealth.js';
import { accountModels, geminiAccounts, geminiUsagePath, limitsFor, modelKey } from './geminiAccounts.js';
import { providerFor } from './registry.js';
import { freeDailyLimitActive, OpenRouterProvider } from './openrouter.js';
import { SearchService } from '../search/router.js';
import { env } from '../env.js';
import { elevenLabsConfigured } from '../elevenlabs/client.js';
import { loadElevenSettings, monthOf, subscriptionBalance } from '../elevenlabs/usage.js';

/** Cloudflare's free daily allocation per account (Workers AI free plan). */
export const CLOUDFLARE_FREE_NEURONS = 10_000;

type Data = Record<string, unknown> | undefined;

/** A nested counter (a.b.c); also accepts the flat "a.b.c" key some stores return. */
function num(data: Data, ...path: string[]): number {
  if (!data) return 0;
  let v: unknown = data;
  for (const k of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  if (v === undefined) v = data[path.join('.')];
  return Number(v ?? 0) || 0;
}

function when(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return null;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

function cooldownsFor(p: H.ProviderName, account: string, shared: Record<string, H.Cooldown>, now: number) {
  const out: { model: string | null; reason: string; until: string }[] = [];
  const prefix = `${account}__`;
  for (const [k, c] of Object.entries(shared)) {
    if (!k.startsWith(prefix) || c.until <= now) continue;
    const scope = k.slice(prefix.length);
    out.push({ model: scope === H.ANY_MODEL || scope === '_' ? null : scope, reason: c.reason, until: new Date(c.until).toISOString() });
  }
  // this instance's own cooldowns (in case the shared copy could not be written)
  const local = H.cooldownOf(p, account, H.ANY_MODEL, now);
  if (local && !out.some((c) => c.model === null)) out.push({ model: null, reason: local.reason, until: new Date(local.until).toISOString() });
  return out;
}

export async function providerOverview(db: Firestore, now = Date.now()) {
  // refresh which models each Gemini project offers (a models listing; no generation quota is used)
  await providerFor('gemini:gemini-3.6-flash').listModels().catch(() => undefined);

  const gDay = pacificDay(now);
  const cDay = utcDay(now);
  const [gDoc, cDoc, gShared, cShared, events, limits] = await Promise.all([
    db.get<Record<string, unknown>>(geminiUsagePath(gDay)).catch(() => null),
    db.get<Record<string, unknown>>(usagePath(cDay)).catch(() => null),
    H.sharedCooldowns('gemini'),
    H.sharedCooldowns('cloudflare'),
    db.list<Record<string, unknown>>('providerEvents', { orderBy: 'at', direction: 'DESCENDING', limit: 60 }).catch(() => []),
    loadLimits(db).catch(() => null),
  ]);
  const g = gDoc?.data;
  const c = cDoc?.data;
  const models = [...GEMINI_FREE_TIER];

  const gemini = {
    day: gDay,
    resetsAt: 'midnight Pacific time',
    accounts: geminiAccounts().map((a) => {
      const offered = accountModels(a.id);
      return {
        id: a.id,
        configured: true,
        modelsListed: offered ? models.filter((m) => offered.includes(m)) : null,
        lastSuccess: when(g?.[`lastOk_${a.id}`]),
        lastFailure: when(g?.[`lastFail_${a.id}`]),
        lastError: typeof g?.[`lastError_${a.id}`] === 'string' ? (g[`lastError_${a.id}`] as string) : null,
        switchedTo: num(g, a.id, 'switchedTo'),
        cooldowns: cooldownsFor('gemini', a.id, gShared, now),
        models: models.map((m) => {
          const lim = limitsFor(a.id, m);
          const k = modelKey(m);
          const requests = num(g, a.id, k, 'requests');
          return {
            model: m,
            requestsToday: requests,
            ok: num(g, a.id, k, 'ok'),
            failed: num(g, a.id, k, 'failed'),
            rateLimited: num(g, a.id, k, 'rateLimited'),
            rpm: lim.rpm ?? null,
            rpmGuard: rpmGuard(lim),
            rpd: lim.rpd ?? null,
            remainingToday: lim.rpd ? Math.max(0, lim.rpd - requests) : null,
            limitSource: lim.source,
            ...H.load('gemini', a.id, m, now),
          };
        }),
      };
    }),
  };

  const cap = limits?.images.appDailyNeurons ?? null;
  const cloudflare = {
    day: cDay,
    resetsAt: '00:00 UTC',
    freeAllowance: CLOUDFLARE_FREE_NEURONS,
    atlasCap: cap,
    accounts: cloudflareAccountIds().map((id) => {
      const used = accountNeurons(c, id);
      const snap = H.localSnapshot('cloudflare', id, H.ANY_MODEL);
      return {
        id,
        configured: true,
        neuronsToday: +used.toFixed(2),
        reservedNow: +num(c, 'accounts', id, 'claimed').toFixed(2),
        remainingUnderCap: cap === null ? null : Math.max(0, +(cap - used).toFixed(2)),
        requests: num(c, 'accounts', id, 'requests'),
        failed: num(c, 'accounts', id, 'failed'),
        allowanceUsedUp: cloudflareDailyLimitActive(now, id),
        usable: cloudflareAccountUsable(id, now),
        lastSuccess: iso(snap.lastOkAt),
        lastFailure: iso(snap.lastFailAt),
        lastError: snap.lastError,
        cooldowns: cooldownsFor('cloudflare', id, cShared, now),
      };
    }),
  };

  const recent = events.map((e) => ({
    id: e.id,
    provider: e.data.provider ?? null,
    account: e.data.account ?? null,
    to: e.data.to ?? null,
    kind: e.data.kind ?? null,
    reason: e.data.reason ?? null,
    model: e.data.model ?? null,
    until: typeof e.data.until === 'number' ? new Date(e.data.until).toISOString() : null,
    at: typeof e.data.at === 'number' ? new Date(e.data.at).toISOString() : null,
  }));

  return { gemini, cloudflare, services: await servicesOverview(db, now), events: recent, generatedAt: new Date(now).toISOString() };
}

/**
 * OpenRouter (free models only), Tavily, SerpAPI and ElevenLabs. Each figure says where it comes
 * from: "provider" = reported by the provider's own account endpoint (free calls that use no
 * quota), "atlas" = Atlas AI's own counters and caps. Nothing is estimated or invented: a figure
 * the provider does not report is null.
 */
export async function servicesOverview(db: Firestore, now = Date.now()) {
  const day = utcDay(now);
  const search = new SearchService();
  const or = new OpenRouterProvider();
  const [orStatus, tavily, serp, elevenBalance, elevenSettings, elevenDay, elevenMonth, limits] = await Promise.all([
    or.accountStatus().catch(() => null),
    env().tavilyKey ? search.reportedUsage('tavily').catch(() => null) : Promise.resolve(null),
    env().serpApiKey ? search.reportedUsage('serpapi').catch(() => null) : Promise.resolve(null),
    elevenLabsConfigured() ? subscriptionBalance(now).catch(() => null) : Promise.resolve(null),
    loadElevenSettings(db).catch(() => null),
    db.get<Record<string, unknown>>(`elevenlabsUsage/${day}`).catch(() => null),
    db.get<Record<string, unknown>>(`elevenlabsUsage/${monthOf(now)}`).catch(() => null),
    loadLimits(db).catch(() => null),
  ]);
  const plan = (u: Awaited<ReturnType<SearchService['reportedUsage']>>) =>
    u ? { used: u.used, limit: u.limit || null, remaining: u.limit ? u.remaining : null, plan: u.plan ?? null, renews: u.renews ?? null, source: 'provider' as const } : null;
  return {
    openrouter: {
      configured: or.isConfigured(),
      freeModelsOnly: true,
      freeDailyLimitReached: freeDailyLimitActive(now),
      reported: orStatus ? { ...orStatus, source: 'provider' as const } : null,
      note: 'Only free models are used. OpenRouter documents 50 free-model requests per day for an account without purchased credits.',
    },
    tavily: {
      configured: Boolean(env().tavilyKey),
      plan: plan(tavily),
      caps: limits ? { daily: limits.tavily.daily, monthly: limits.tavily.monthly, perUser: true, source: 'atlas' as const } : null,
    },
    serpapi: {
      configured: Boolean(env().serpApiKey),
      plan: plan(serp),
      caps: limits ? { daily: limits.serpapi.daily, monthly: limits.serpapi.monthly, perUser: true, source: 'atlas' as const } : null,
    },
    elevenlabs: {
      configured: elevenLabsConfigured(),
      enabled: elevenSettings?.enabled ?? false,
      balance: elevenBalance ? { remainingCredits: elevenBalance.remaining, active: elevenBalance.active, source: 'provider' as const } : null,
      today: {
        credits: num(elevenDay?.data, 'credits'),
        requests: num(elevenDay?.data, 'requests'),
        failed: num(elevenDay?.data, 'failed'),
        source: 'atlas' as const,
      },
      month: { credits: num(elevenMonth?.data, 'credits'), source: 'atlas' as const },
      caps: elevenSettings
        ? { appDaily: elevenSettings.appDailyCredits, appMonthly: elevenSettings.appMonthlyCredits, perUserDaily: elevenSettings.userDailyCredits, source: 'atlas' as const }
        : null,
    },
  };
}

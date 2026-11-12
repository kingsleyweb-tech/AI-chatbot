/**
 * Short-lived memory of models that just failed, per server instance.
 *
 * Without it every message retries a model whose free quota is used up (or
 * that is hanging), and the user waits for that failure each time before the
 * fallback answers. A model in cooldown is moved to the end of the chain, not
 * removed, so it is still tried if everything else fails.
 *
 * Repeated failures back off: a model that times out again right after its
 * cooldown ended rests twice as long, then four times, up to a ceiling, so a
 * model that keeps hanging costs the wait once and then stays out of the way.
 * A success resets it. State lives only in memory (a cold start forgets it,
 * which is safe); Gemini's per-account cooldowns, which every instance shares,
 * are checked as well through `preferHealthy`'s `resting` argument. No test
 * request is ever sent: the next real request after a cooldown is the check.
 */
import type { ProviderErrorCode } from './types.js';

/** First cooldown per error, and the ceiling repeated failures can reach. */
const COOLDOWN: Partial<Record<ProviderErrorCode, { baseMs: number; maxMs: number }>> = {
  rate_limited: { baseMs: 90_000, maxMs: 15 * 60_000 },
  daily_limit: { baseMs: 30 * 60_000, maxMs: 60 * 60_000 },
  timeout: { baseMs: 3 * 60_000, maxMs: 30 * 60_000 },
  provider_error: { baseMs: 60_000, maxMs: 10 * 60_000 },
  model_unavailable: { baseMs: 10 * 60_000, maxMs: 60 * 60_000 },
  insufficient_credits: { baseMs: 30 * 60_000, maxMs: 60 * 60_000 },
};

interface State {
  until: number;
  streak: number;
}

const state = new Map<string, State>();

export function markFailed(model: string, code: ProviderErrorCode, now = Date.now()) {
  const c = COOLDOWN[code];
  if (!c) return;
  const prev = state.get(model);
  // a failure long after the previous cooldown ended starts over
  const streak = prev && now - prev.until < c.maxMs ? prev.streak + 1 : 1;
  const ms = Math.min(c.maxMs, c.baseMs * 2 ** (streak - 1));
  state.set(model, { until: now + ms, streak });
}

export function markHealthy(model: string) {
  state.delete(model);
}

export function coolingDown(model: string, now = Date.now()): boolean {
  const s = state.get(model);
  // after the cooldown the streak is kept (a further failure backs off longer) until a success
  return s !== undefined && s.until > now;
}

/** How many failures in a row (0 when healthy); for tests and diagnostics. */
export function failureStreak(model: string): number {
  return state.get(model)?.streak ?? 0;
}

/**
 * Healthy models first (order kept), models in cooldown last. `resting` adds a provider's own
 * view, for example "every Gemini account is resting for this model".
 */
export function preferHealthy(chain: string[], now = Date.now(), resting: (model: string) => boolean = () => false): string[] {
  const down = (m: string) => coolingDown(m, now) || resting(m);
  const ok = chain.filter((m) => !down(m));
  return ok.length === chain.length ? chain : [...ok, ...chain.filter(down)];
}

/** for tests */
export function resetHealth() {
  state.clear();
}

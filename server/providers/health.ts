/**
 * Short-lived memory of models that just failed, per server instance.
 *
 * Without it every message retries a model whose free quota is used up (or
 * that is hanging), and the user waits for that failure each time before the
 * fallback answers. A model in cooldown is moved to the end of the chain, not
 * removed, so it is still tried if everything else fails. State lives only in
 * memory: a cold start simply forgets it, which is safe.
 */
import type { ProviderErrorCode } from './types.js';

const COOLDOWN_MS: Partial<Record<ProviderErrorCode, number>> = {
  rate_limited: 90_000,
  daily_limit: 30 * 60_000,
  timeout: 3 * 60_000,
  model_unavailable: 10 * 60_000,
  insufficient_credits: 30 * 60_000,
};

const until = new Map<string, number>();

export function markFailed(model: string, code: ProviderErrorCode, now = Date.now()) {
  const ms = COOLDOWN_MS[code];
  if (ms) until.set(model, now + ms);
}

export function markHealthy(model: string) {
  until.delete(model);
}

export function coolingDown(model: string, now = Date.now()): boolean {
  const t = until.get(model);
  if (t === undefined) return false;
  if (t <= now) {
    until.delete(model);
    return false;
  }
  return true;
}

/** Healthy models first (order kept), models in cooldown last. */
export function preferHealthy(chain: string[], now = Date.now()): string[] {
  const ok = chain.filter((m) => !coolingDown(m, now));
  return ok.length === chain.length ? chain : [...ok, ...chain.filter((m) => coolingDown(m, now))];
}

/** for tests */
export function resetHealth() {
  until.clear();
}

/**
 * Which API environment (Main, Secondary, Temporary Public Testing) an application's request uses.
 *
 * Decided only on the server from the trusted configuration: the global environment settings
 * (Super Admin > Environments), the integration's allowed environments and the key mode's
 * environment choice. Nothing in a request can choose an environment or supply credentials.
 *
 * - "Active" follows the global configuration, provider by provider, exactly like the website.
 * - A fixed choice (e.g. test keys on Temporary) sets every provider to that environment where it
 *   has credentials (the same mapping as a global switch; providers without that environment use
 *   Main).
 * - A provider whose resulting environment is not allowed for the integration is switched off for
 *   this request. The existing environment-locked fallback chain then refuses instead of quietly
 *   using another environment: Temporary is never silently replaced by Main, and the other way round.
 * - The configuration is pinned when the request starts (server/environments). A later switch never
 *   changes a request already running, including a streamed reply.
 *
 * ElevenLabs is not environment-specific and stays shared, as in the rest of Atlas AI; the
 * Temporary ceiling, provider safeguards and emergency stops keep applying.
 */
import { currentPin, type Pin } from '../environments/index.js';
import { HttpError } from '../http.js';
import { ENV_LABEL, ENV_PROVIDERS, globalTarget, overallEnvironment, type EnvId, type EnvironmentConfig } from '../shared/environments.js';
import type { IntegrationConfig, KeyMode } from '../shared/apiPlatform.js';

export interface IntegrationPin {
  pin: Pin;
  /** the environment shown in logs and responses ("mixed" when providers differ) */
  environment: EnvId | 'mixed';
}

export function integrationPin(integration: IntegrationConfig, mode: KeyMode, base: Pin = currentPin()): IntegrationPin {
  if (base.unavailable) throw new HttpError(503, 'environment_unavailable', 'The API environment settings could not be loaded. Please try again shortly.');
  const choice = integration.environment[mode];
  const src = base.config;
  const config: EnvironmentConfig = {
    ...src,
    providers: { ...src.providers },
    disabled: Object.fromEntries(ENV_PROVIDERS.map((p) => [p, [...src.disabled[p]]])) as EnvironmentConfig['disabled'],
  };
  if (choice !== 'active') for (const p of ENV_PROVIDERS) config.providers[p] = globalTarget(p, choice);

  const allowed = new Set(integration.allowedEnvironments);
  let usable = 0;
  for (const p of ENV_PROVIDERS) {
    const e = config.providers[p];
    if (!allowed.has(e) && !config.disabled[p].includes(e)) config.disabled[p].push(e);
    if (!config.disabled[p].includes(e)) usable++;
  }
  if (!usable) {
    const wanted = choice === 'active' ? overallEnvironment(src) : choice;
    const label = wanted === 'mixed' ? 'the current environments' : `the ${ENV_LABEL[wanted]} environment`;
    throw new HttpError(503, 'environment_not_permitted', `This application is not permitted to use ${label}, so the request was not run.`);
  }
  return { pin: { ...base, config }, environment: overallEnvironment(config) };
}

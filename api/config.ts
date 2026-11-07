import { requireAllowedUser } from '../server/access.js';
import { handle, json } from '../server/http.js';
import { configuredProviders } from '../server/providers/registry.js';
import { searchService } from '../server/search/router.js';
import type { AppCapabilities } from '../server/shared/types.js';

/** Server capabilities + the caller's access level. Never includes secrets. */
export const GET = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const { providers } = searchService();
  const list = [providers.serpapi, providers.tavily].map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured() }));
  const primary = list.find((p) => p.configured) ?? null;
  const caps: AppCapabilities & { admin: boolean } = {
    searchAvailable: Boolean(primary),
    searchProvider: primary?.label ?? null,
    searchProviders: list,
    embeddingsAvailable: configuredProviders().includes('openrouter'),
    providers: configuredProviders(),
    admin: ctx.admin,
  };
  return json(caps);
});

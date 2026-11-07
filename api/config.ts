import { requireAllowedUser } from '../server/access.js';
import { handle, json } from '../server/http.js';
import { configuredProviders } from '../server/providers/registry.js';
import { searchProvider } from '../server/search/tavily.js';
import type { AppCapabilities } from '../server/shared/types.js';

/** Server capabilities + the caller's access level. */
export const GET = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const sp = searchProvider();
  const caps: AppCapabilities & { admin: boolean } = {
    searchAvailable: sp.isConfigured(),
    searchProvider: sp.isConfigured() ? sp.id : null,
    embeddingsAvailable: configuredProviders().includes('openrouter'),
    providers: configuredProviders(),
    admin: ctx.admin,
  };
  return json(caps);
});

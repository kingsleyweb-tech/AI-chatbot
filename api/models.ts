import { requireAllowedUser } from '../server/access.js';
import { loadAiConfig } from '../server/config/ai.js';
import { handle, HttpError, json } from '../server/http.js';
import { getCatalog } from '../server/providers/registry.js';
import { ProviderError } from '../server/providers/types.js';

export const GET = handle(async (request) => {
  const { db } = await requireAllowedUser(request);
  try {
    const [catalog, ai] = await Promise.all([getCatalog(), loadAiConfig(db)]);
    // admin default model, if it is offered; the built-in default otherwise
    const adminDefault = ai.defaultModel && catalog.models.some((m) => m.id === ai.defaultModel) ? ai.defaultModel : null;
    return json({ ...catalog, defaultModel: adminDefault ?? catalog.defaultModel, preferredProvider: ai.preferredProvider }, { headers: { 'cache-control': 'private, max-age=300' } });
  } catch (err) {
    if (err instanceof ProviderError) throw new HttpError(502, err.code, err.message);
    throw err;
  }
});

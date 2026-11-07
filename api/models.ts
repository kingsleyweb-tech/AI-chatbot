import { requireAllowedUser } from '../server/access.js';
import { handle, HttpError, json } from '../server/http.js';
import { getCatalog } from '../server/providers/registry.js';
import { ProviderError } from '../server/providers/types.js';

export const GET = handle(async (request) => {
  await requireAllowedUser(request);
  try {
    const catalog = await getCatalog();
    return json(catalog, { headers: { 'cache-control': 'private, max-age=300' } });
  } catch (err) {
    if (err instanceof ProviderError) throw new HttpError(502, err.code, err.message);
    throw err;
  }
});

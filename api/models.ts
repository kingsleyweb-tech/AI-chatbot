import { waitUntil } from '@vercel/functions';
import { requireAllowedUser } from '../server/access.js';
import { handleV1 } from '../server/apiPlatform/router.js';
import { loadAiConfig } from '../server/config/ai.js';
import { handle, HttpError, json } from '../server/http.js';
import { getCatalog } from '../server/providers/registry.js';
import { ProviderError } from '../server/providers/types.js';

/**
 * GET /api/models: the model catalog for the signed-in user.
 *
 * Also serves the Atlas AI API for connected applications: /api/v1/... is rewritten to
 * /api/models?v1path=... (vercel.json), because the Hobby plan's 12 functions are all in use.
 * Those requests are authenticated with Atlas AI API keys, never with a user session.
 */
const v1 = (request: Request): Response | Promise<Response> | null => {
  const paths = new URL(request.url).searchParams.getAll('v1path');
  if (!paths.length) return null;
  if (paths.length > 1) return json({ success: false, error: { code: 'bad_request', message: 'Invalid request path.' } }, { status: 400 });
  return handleV1(request, paths[0], { background: (p) => waitUntil(p) });
};

const catalog = handle(async (request) => {
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

/** Atlas AI API routes (pinned to the request's environment configuration by handle()). */
const api = handle(async (request) => v1(request) ?? json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 }));

export const GET = (request: Request) => (new URL(request.url).searchParams.has('v1path') ? api(request) : catalog(request));
export const POST = api;
export const DELETE = api;
export const OPTIONS = api;

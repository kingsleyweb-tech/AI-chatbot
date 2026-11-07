import { z } from 'zod';
import { requireAllowedUser } from '../server/access.js';
import { indexDocument } from '../server/docs/documents.js';
import { handle, HttpError, json, readJson } from '../server/http.js';

const schema = z.object({
  documentId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128),
  sections: z
    .array(z.object({ ref: z.string().max(200), text: z.string() }))
    .max(5000),
});

/**
 * Text is extracted in the browser (so large files never hit the 4.5 MB
 * serverless body limit); this endpoint chunks, embeds and stores it.
 */
export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  const parsed = schema.safeParse(await readJson(request, 4_400_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid document payload.');
  const result = await indexDocument({
    db: ctx.db,
    uid: ctx.user.uid,
    documentId: parsed.data.documentId,
    sections: parsed.data.sections,
  });
  return json({ ok: true, ...result });
});

/**
 * Documents waiting in the composer for the next message (pure: shared by the chat page,
 * the composer and the tests).
 *
 * A document goes through: Uploading (file to Storage) -> Processing (text extracted and
 * indexed) -> Ready, or Failed at either step. It stays in the composer until the message it
 * was sent with has been stored; only then does it move into that message. A conversation
 * keeps searching every document it was given, sent or not.
 */
// relative imports (no path aliases): the tests import this file directly
import type { DocumentAttachment } from '../../../server/shared/types.js';

/** the fields of a document's metadata (lib/types DocumentMeta) used here */
interface DocumentMeta {
  id: string;
  name: string;
  mime: string;
  status: 'processing' | 'ready' | 'failed';
}

export interface PendingUpload {
  /** local id of this upload (not a document id) */
  id: string;
  /** conversation the upload belongs to ('new' for a chat not yet created) */
  key: string;
  name: string;
  status: 'uploading' | 'failed';
  error?: string;
}

export type AttachmentStage = 'uploading' | 'processing' | 'ready' | 'failed';

export function documentStage(d: Pick<DocumentMeta, 'status'>): AttachmentStage {
  return d.status === 'ready' ? 'ready' : d.status === 'failed' ? 'failed' : 'processing';
}

export interface SendPlan {
  /** attachment references stored with the message */
  attachments: DocumentAttachment[];
  /** ids that move out of the composer once the message is stored */
  sentIds: string[];
  /** a document is still uploading or being read: sending now would leave it out */
  waiting: boolean;
}

/** What the next message takes from the composer. Failed documents stay behind (retry or remove). */
export function planSend(pending: DocumentMeta[], uploads: Pick<PendingUpload, 'status'>[]): SendPlan {
  const ready = pending.filter((d) => documentStage(d) === 'ready');
  return {
    attachments: ready.map((d) => ({ kind: 'document', documentId: d.id, name: d.name, mime: d.mime })),
    sentIds: ready.map((d) => d.id),
    waiting: uploads.some((u) => u.status === 'uploading') || pending.some((d) => documentStage(d) === 'processing'),
  };
}

/** Remove the sent ids from a composer list, keeping everything else in order. */
export function withoutSent(ids: string[], sent: string[]): string[] {
  if (!sent.length) return ids;
  const s = new Set(sent);
  return ids.filter((id) => !s.has(id));
}

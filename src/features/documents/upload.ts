import { serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { api, ApiError } from '@/lib/api';
import { paths } from '@/lib/db';
import { detectKind, extractText, MAX_DOC_BYTES } from '@/lib/extract';
import { newId } from '@/lib/utils';

const MAX_PAYLOAD_CHARS = 3_800_000;

/**
 * Document pipeline (client half): validate → create metadata → extract text
 * in the browser → send sections to /api/documents for chunking + embedding.
 * Status is tracked on the Firestore document so every view stays in sync.
 */
export async function uploadDocument(uid: string, file: File): Promise<string> {
  if (file.size > MAX_DOC_BYTES) throw new Error(`${file.name} is larger than 25 MB.`);
  if (detectKind(file) === 'unsupported') {
    throw new Error(`${file.name}: unsupported file type. Use PDF, DOCX, TXT, CSV, XLSX or PPTX.`);
  }
  const id = newId();
  const ref = paths.document(uid, id);
  await setDoc(ref, {
    name: file.name.slice(0, 300),
    mime: file.type || 'application/octet-stream',
    size: file.size,
    status: 'processing',
    error: null,
    createdAt: serverTimestamp(),
  });

  void (async () => {
    try {
      const result = await extractText(file);
      let sections = result.sections.map((s) => ({ ref: s.ref.slice(0, 200), text: s.text }));
      let total = sections.reduce((n, s) => n + s.text.length, 0);
      if (!total) throw new Error('No readable text was found in this file.');
      let truncated = false;
      if (total > MAX_PAYLOAD_CHARS) {
        const out: typeof sections = [];
        let used = 0;
        for (const s of sections) {
          if (used >= MAX_PAYLOAD_CHARS) break;
          const text = s.text.slice(0, MAX_PAYLOAD_CHARS - used);
          out.push({ ...s, text });
          used += text.length;
        }
        sections = out;
        total = used;
        truncated = true;
      }
      if (result.pageCount) await updateDoc(ref, { pageCount: result.pageCount }).catch(() => undefined);
      await api('documents', { json: { documentId: id, sections } });
      const warning = [result.warning, truncated ? 'Only the first part of this very large document was processed.' : null]
        .filter(Boolean)
        .join(' ');
      if (warning) await updateDoc(ref, { warning }).catch(() => undefined);
    } catch (err) {
      const message =
        err instanceof ApiError || err instanceof Error ? err.message : 'Text extraction failed.';
      await updateDoc(ref, { status: 'failed', error: message.slice(0, 300) }).catch(() => undefined);
    }
  })();

  return id;
}

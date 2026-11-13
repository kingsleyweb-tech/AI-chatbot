import { collection, doc, getDoc, getDocs, type DocumentData } from 'firebase/firestore';
import { api } from './api';
import { db } from './firebase';

/**
 * Export of everything the account owner can read: profile and settings,
 * conversations with their messages, memories, projects and project memory,
 * saved responses, document metadata (not the indexed chunks), usage and
 * security events. Built in the browser with the owner's own credentials, so
 * the security rules decide what is included; nothing passes through a third
 * party. Firestore timestamps become ISO strings.
 */
export interface AccountExport {
  format: 'atlas-account-export';
  version: 1;
  exportedAt: string;
  uid: string;
  profile: DocumentData | null;
  conversations: (DocumentData & { id: string; messages: DocumentData[] })[];
  memories: DocumentData[];
  projects: DocumentData[];
  projectMemory: DocumentData[];
  savedResponses: DocumentData[];
  documents: DocumentData[];
  usage: DocumentData[];
  securityEvents: DocumentData[];
  skipped: string[];
}

/** Firestore values to plain JSON (Timestamps to ISO strings, vectors dropped). */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const v = value as { toDate?: () => Date };
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) {
      if (k === 'embedding' || k === 'vector' || k === 'vectors') continue;
      out[k] = plain(x);
    }
    return out;
  }
  return value;
}

export async function buildAccountExport(
  uid: string,
  onProgress?: (label: string) => void,
): Promise<AccountExport> {
  const skipped: string[] = [];
  const list = async (name: string, ...segments: string[]): Promise<DocumentData[]> => {
    try {
      const snap = await getDocs(collection(db, 'users', uid, ...segments));
      return snap.docs.map((d) => ({ id: d.id, ...(plain(d.data()) as DocumentData) }));
    } catch {
      skipped.push(name);
      return [];
    }
  };

  onProgress?.('Profile');
  const profileSnap = await getDoc(doc(db, 'users', uid)).catch(() => null);
  const profile = profileSnap?.exists() ? (plain(profileSnap.data()) as DocumentData) : null;

  onProgress?.('Conversations');
  const convs = await list('conversations', 'conversations');
  const conversations: AccountExport['conversations'] = [];
  for (let i = 0; i < convs.length; i++) {
    onProgress?.(`Conversations (${i + 1} of ${convs.length})`);
    const c = convs[i] as DocumentData & { id: string };
    const messages = (await list(`messages of ${c.id}`, 'conversations', c.id, 'messages')).sort(
      (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
    );
    conversations.push({ ...c, messages });
  }

  onProgress?.('Memories and projects');
  const [memories, projects, projectMemory, savedResponses, documents, usage, securityEvents] =
    await Promise.all([
      list('memories', 'memories'),
      list('projects', 'projects'),
      list('projectMemory', 'projectMemory'),
      list('savedResponses', 'savedResponses'),
      list('documents', 'documents'),
      list('usage', 'usage'),
      list('securityEvents', 'securityEvents'),
    ]);

  return {
    format: 'atlas-account-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    uid,
    profile,
    conversations,
    memories,
    projects,
    projectMemory,
    savedResponses,
    documents,
    usage,
    securityEvents: securityEvents.sort((a, b) =>
      String(b.at ?? '').localeCompare(String(a.at ?? '')),
    ),
    skipped,
  };
}

/** Build the export, save it as a JSON file and record a security event. */
export async function downloadAccountExport(
  uid: string,
  onProgress?: (label: string) => void,
): Promise<AccountExport> {
  const data = await buildAccountExport(uid, onProgress);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `atlas-export-${data.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  void api('account', { json: { action: 'exported' } }).catch(() => undefined);
  return data;
}

/** Build the export and open the print dialog to save it as a readable PDF. */
export async function printAccountExport(
  uid: string,
  onProgress?: (label: string) => void,
): Promise<AccountExport> {
  const data = await buildAccountExport(uid, onProgress);
  onProgress?.('Laying out the PDF');
  const { printAccountPdf } = await import('./accountPdf');
  await printAccountPdf(data);
  void api('account', { json: { action: 'exported' } }).catch(() => undefined);
  return data;
}

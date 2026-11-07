import { limit, orderBy, query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { Button, Dialog, Label, Select } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import type { KbCollection, Source } from '@/lib/types';
import { domainOf } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { addUrl, createCollection, kbPaths } from './kb';

/**
 * Save selected web search results to the user's knowledge base. Nothing is
 * saved automatically: the user picks the pages and the collection. Pages are
 * re-read from the source (not copied from the search snippet), and a page
 * already in the knowledge base is refreshed instead of duplicated.
 */
export function SaveToKnowledgeDialog({ open, onClose, sources }: { open: boolean; onClose: () => void; sources: Source[] }) {
  const uid = useUid();
  const toast = useToast();
  const cols = useQuery<KbCollection>(open ? query(kbPaths.collections('personal', uid), orderBy('createdAt', 'asc'), limit(200)) : null, [uid, open]);
  const [collectionId, setCollectionId] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setPicked(new Set(sources.slice(0, 1).map((s) => s.index)));
      setErrors([]);
    }
  }, [open, sources]);
  useEffect(() => {
    if (!collectionId && cols.data.length) {
      const companies = cols.data.find((c) => /compan|organi/i.test(c.name));
      setCollectionId((companies ?? cols.data[0]).id);
    }
  }, [cols.data, collectionId]);

  const save = async () => {
    setSaving(true);
    setErrors([]);
    let target = collectionId;
    if (!target) target = await createCollection('personal', uid, 'General Knowledge');
    const failed: string[] = [];
    let added = 0;
    for (const s of sources.filter((x) => picked.has(x.index))) {
      try {
        await addUrl('personal', { collectionId: target, url: s.url, addedFrom: 'web_search' });
        added++;
      } catch (err) {
        failed.push(`${domainOf(s.url)}: ${err instanceof Error ? err.message : 'could not be saved'}`);
      }
    }
    setSaving(false);
    if (added) toast(`Saved ${added} page${added > 1 ? 's' : ''} to your knowledge base.`, 'success');
    if (failed.length) setErrors(failed);
    else onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save to knowledge base"
      description="The selected pages are read again from their websites and indexed, so later questions can use them without searching."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!picked.size} onClick={save}>
            Save {picked.size > 1 ? `${picked.size} pages` : 'page'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {sources.map((s) => (
            <li key={s.index}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--accent)]"
                  checked={picked.has(s.index)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (e.target.checked) n.add(s.index);
                      else n.delete(s.index);
                      return n;
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{s.title || domainOf(s.url)}</span>
                  <span className="block truncate text-xs text-muted">{domainOf(s.url)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {cols.data.length > 0 ? (
          <div>
            <Label htmlFor="save-col">Collection</Label>
            <Select id="save-col" value={collectionId} onChange={setCollectionId} options={cols.data.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
        ) : (
          !cols.loading && <p className="text-xs text-muted">A “General Knowledge” collection will be created.</p>
        )}
        {errors.length > 0 && (
          <ul className="space-y-1 text-sm text-danger">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

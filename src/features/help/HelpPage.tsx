import { collection, getDocs } from 'firebase/firestore';
import { BookOpen, ChevronRight, LifeBuoy, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Markdown } from '@/components/Markdown';
import { Button, ConfirmDialog, Dialog, EmptyState, Input, Label, Textarea } from '@/components/ui';
import { db } from '@/lib/firebase';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { HELP_ARTICLES, HELP_CATEGORIES, mergeArticles, searchArticles, type HelpArticle } from '@shared/help';
import { Page } from '../shell/Page';
import { supportApi } from '../support/api';
import { errorText, fmtDate } from '../support/parts';

/** Built-in articles merged with administrator edits (helpArticles). */
function useArticles() {
  const [overrides, setOverrides] = useState<HelpArticle[]>([]);
  const reload = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'helpArticles'));
      setOverrides(snap.docs.map((d) => ({ ...(d.data() as HelpArticle), id: d.id })));
    } catch {
      setOverrides([]); // rules not published yet, or offline: built-in articles still work
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  return { articles: useMemo(() => mergeArticles(overrides), [overrides]), overrides, reload };
}

export default function HelpPage() {
  const { id } = useParams();
  const { admin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { articles, overrides, reload } = useArticles();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<HelpArticle | 'new' | null>(null);
  const [removing, setRemoving] = useState<HelpArticle | null>(null);

  const results = useMemo(() => searchArticles(articles, q), [articles, q]);
  const article = id ? articles.find((a) => a.id === id) : undefined;
  const builtIn = (aid: string) => HELP_ARTICLES.some((a) => a.id === aid);
  const edited = (aid: string) => builtIn(aid) && overrides.some((o) => o.id === aid && !o.hidden);
  const hiddenBuiltIns = HELP_ARTICLES.filter((a) => overrides.some((o) => o.id === a.id && o.hidden));

  const adminTools = admin && (
    <div className="mt-8 rounded-2xl border border-dashed border-border-strong px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">Administrator: articles you add or edit are shown to every user.</span>
        <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          New article
        </Button>
      </div>
      {hiddenBuiltIns.length > 0 && (
        <div className="mt-3 text-xs text-muted">
          Removed built-in articles:{' '}
          {hiddenBuiltIns.map((a) => (
            <button
              key={a.id}
              className="mr-2 text-accent hover:underline"
              onClick={async () => {
                try {
                  await supportApi.helpRemove(a.id, 'restore');
                  toast(`Restored “${a.title}”.`, 'success');
                  void reload();
                } catch (err) {
                  toast(errorText(err), 'error');
                }
              }}
            >
              Restore “{a.title}”
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const dialogs = (
    <>
      {editing && (
        <ArticleEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(aid) => {
            setEditing(null);
            void reload();
            navigate(`/help/${aid}`);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this article?"
        message={removing && builtIn(removing.id) ? 'The built-in article is hidden from users. You can restore it later.' : 'The article is deleted for every user.'}
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          if (!removing) return;
          try {
            await supportApi.helpRemove(removing.id, 'remove');
            toast('Article removed.', 'success');
            setRemoving(null);
            void reload();
            navigate('/help');
          } catch (err) {
            toast(errorText(err), 'error');
          }
        }}
      />
    </>
  );

  if (id) {
    return (
      <Page title={article?.title ?? 'Help Centre'} back="/help">
        {!article ? (
          <EmptyState icon={<BookOpen className="size-6" />} title="Article not found" action={<Button onClick={() => navigate('/help')}>Help Centre</Button>}>
            It may have been moved or removed.
          </EmptyState>
        ) : (
          <article className="mx-auto max-w-2xl">
            <p className="mb-1 text-xs text-muted">
              <Link to="/help" className="hover:text-fg">
                Help Centre
              </Link>{' '}
              · {article.category}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">{article.title}</h1>
            {article.summary && <p className="mt-1.5 text-[15px] text-muted">{article.summary}</p>}
            <div className="mt-6">
              <Markdown content={article.body} />
            </div>
            {article.updatedAt && <p className="mt-6 text-xs text-subtle">Updated {fmtDate(article.updatedAt, false)}</p>}
            {admin && (
              <div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-4">
                <Button size="sm" variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(article)}>
                  Edit
                </Button>
                {edited(article.id) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await supportApi.helpRemove(article.id, 'restore');
                        toast('Restored the original article.', 'success');
                        void reload();
                      } catch (err) {
                        toast(errorText(err), 'error');
                      }
                    }}
                  >
                    Restore original
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setRemoving(article)}>
                  Remove
                </Button>
              </div>
            )}
            <div className="mt-10 rounded-2xl bg-surface-2 px-4 py-4 text-sm">
              <p className="font-medium">Still need help?</p>
              <p className="mt-0.5 text-muted">Send a report and Atlas Support will reply in the app.</p>
              <Link to="/support/new" className="mt-3 inline-block">
                <Button size="sm" icon={<LifeBuoy className="size-4" />}>
                  Contact support
                </Button>
              </Link>
            </div>
          </article>
        )}
        {dialogs}
      </Page>
    );
  }

  const categories = [...new Set([...HELP_CATEGORIES, ...articles.map((a) => a.category)])];
  return (
    <Page title="Help Centre" back="/settings">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">Help Centre</h1>
        <p className="mb-5 text-sm text-muted">Guides for using Atlas AI.</p>
        <div className="relative mb-6">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input type="search" aria-label="Search help articles" placeholder="Search help, e.g. “reset password”" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>

        {q.trim() ? (
          results.length ? (
            <ArticleList items={results} />
          ) : (
            <EmptyState icon={<Search className="size-6" />} title="No articles found" action={<Link to="/support/new"><Button>Contact support</Button></Link>}>
              Try other words, or ask Atlas Support.
            </EmptyState>
          )
        ) : (
          categories.map((c) => {
            const items = articles.filter((a) => a.category === c);
            if (!items.length) return null;
            return (
              <section key={c} className="mb-7">
                <h2 className="mb-1.5 px-4 text-[13px] font-medium text-muted">{c}</h2>
                <ArticleList items={items} />
              </section>
            );
          })
        )}

        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Link to="/support/new" className="rounded-2xl border border-border bg-elevated px-4 py-3.5 transition-colors hover:bg-surface-2">
            <div className="text-[15px] font-medium">Contact support</div>
            <div className="text-xs text-muted">Report a problem or send feedback</div>
          </Link>
          <Link to="/support" className="rounded-2xl border border-border bg-elevated px-4 py-3.5 transition-colors hover:bg-surface-2">
            <div className="text-[15px] font-medium">My reports</div>
            <div className="text-xs text-muted">Follow replies and status</div>
          </Link>
        </div>
        {adminTools}
      </div>
      {dialogs}
    </Page>
  );
}

function ArticleList({ items }: { items: HelpArticle[] }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl bg-elevated">
      {items.map((a) => (
        <li key={a.id}>
          <Link to={`/help/${a.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px]">{a.title}</span>
              {a.summary && <span className="block truncate text-xs text-muted">{a.summary}</span>}
            </span>
            <ChevronRight className="size-4 shrink-0 text-subtle" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ArticleEditor({ initial, onClose, onSaved }: { initial: HelpArticle | null; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    id: initial?.id ?? '',
    title: initial?.title ?? '',
    category: initial?.category ?? HELP_CATEGORIES[1],
    summary: initial?.summary ?? '',
    body: initial?.body ?? '',
    keywords: (initial?.keywords ?? []).join(', '),
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const id = initial?.id ?? (f.id || f.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60));

  const save = async () => {
    setBusy(true);
    try {
      await supportApi.helpSave({ id, title: f.title.trim(), category: f.category.trim(), summary: f.summary.trim(), body: f.body, keywords: f.keywords.split(',').map((k) => k.trim()).filter(Boolean) });
      toast('Article saved.', 'success');
      onSaved(id);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? 'Edit article' : 'New article'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={busy || f.title.trim().length < 3 || f.body.trim().length < 10 || !id}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="a-title">Title</Label>
          <Input id="a-title" value={f.title} onChange={set('title')} maxLength={120} />
          {!initial && <p className="mt-1 text-xs text-muted">Address: /help/{id || '…'}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="a-category">Category</Label>
            <Input id="a-category" value={f.category} onChange={set('category')} maxLength={60} list="help-categories" />
            <datalist id="help-categories">
              {HELP_CATEGORIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <Label htmlFor="a-keywords" hint="Comma separated, helps search">
              Keywords
            </Label>
            <Input id="a-keywords" value={f.keywords} onChange={set('keywords')} />
          </div>
        </div>
        <div>
          <Label htmlFor="a-summary">Summary</Label>
          <Input id="a-summary" value={f.summary} onChange={set('summary')} maxLength={240} />
        </div>
        <div>
          <Label htmlFor="a-body" hint="Markdown: **bold**, lists, links">
            Article
          </Label>
          <Textarea id="a-body" rows={12} value={f.body} onChange={set('body')} maxLength={20000} className="font-mono text-[13px]" />
        </div>
      </div>
    </Dialog>
  );
}

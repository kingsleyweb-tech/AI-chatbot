/**
 * Public documentation, laid out like a docs site: its own header (search
 * with Ctrl K, tabs), a full-height sidebar, the article with "Copy page",
 * and an "On this page" list on wide screens.
 */
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Bell,
  BookOpen,
  Brain,
  Check,
  Code2,
  Copy,
  Download,
  FileText,
  FolderKanban,
  Globe,
  ImageIcon,
  KeyRound,
  Languages,
  LifeBuoy,
  LogIn,
  Menu,
  MessageSquare,
  Newspaper,
  Rocket,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Telescope,
  Trash2,
  UserCheck,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { cn, copyText } from '@/lib/utils';
import { DOC_SECTIONS, DOCS, docHeadings, searchDocs, type DocArticle } from '../content/docs';
import { APP_LINKS, PAGES } from '../content/site';
import { Seo } from '../layout/Seo';
import { SiteMarkdown } from '../layout/SiteMarkdown';
import { NotFoundPage } from './InfoPages';

const ICONS: Record<string, LucideIcon> = {
  'getting-started': Rocket,
  install: Download,
  'sign-in': LogIn,
  chatting: MessageSquare,
  models: Sparkles,
  memory: Brain,
  projects: FolderKanban,
  'web-search': Globe,
  'deep-research': Telescope,
  news: Newspaper,
  documents: FileText,
  images: ImageIcon,
  voice: Languages,
  'voice-mode': AudioLines,
  'account-security': ShieldCheck,
  'password-reset': KeyRound,
  'access-approval': UserCheck,
  'delete-account': Trash2,
  'data-and-privacy': Bell,
  'responsible-use': Scale,
  troubleshooting: Wrench,
  'reporting-problems': LifeBuoy,
  developers: Code2,
};
const iconFor = (slug: string) => ICONS[slug] ?? BookOpen;

/* ------------------------------------------------------------ Search (Ctrl K) */

function SearchDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const results = useMemo(() => (q.trim().length > 1 ? searchDocs(q).slice(0, 8) : DOCS.slice(0, 6)), [q]);
  const go = (d: DocArticle) => {
    onClose();
    navigate(`/docs/${d.slug}`);
  };
  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label="Search the documentation">
      <button type="button" aria-label="Close search" className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="shadow-panel relative mx-auto mt-[12vh] w-[min(600px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border bg-elevated">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-4.5 text-subtle" aria-hidden="true" />
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter' && results[sel]) go(results[sel]);
            }}
            placeholder="Search the docs"
            aria-label="Search the documentation"
            className="h-14 flex-1 bg-transparent text-[15px] outline-none"
          />
          <kbd className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-subtle">Esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2" aria-live="polite">
          {!q.trim() && <p className="px-3 pt-1 pb-2 text-xs font-medium text-subtle">Start here</p>}
          {results.length ? (
            results.map((d, i) => {
              const Icon = iconFor(d.slug);
              return (
                <button
                  key={d.slug}
                  type="button"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => go(d)}
                  className={cn('flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left', i === sel && 'bg-surface')}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{d.title}</span>
                    <span className="block truncate text-xs text-muted">{d.summary}</span>
                  </span>
                </button>
              );
            })
          ) : (
            <p className="px-3 py-4 text-sm text-muted">No results for “{q}”.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Header */

const TABS = [
  { label: 'Documentation', href: '/docs' },
  { label: 'Help Centre', href: '/help-centre' },
  { label: 'Trust', href: '/trust' },
  { label: 'Status', href: '/status' },
];

function DocsHeader({ onMenu }: { onMenu: () => void }) {
  const [search, setSearch] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 lg:px-6">
        <Link to="/" className="flex shrink-0 items-center gap-2 rounded-lg" aria-label="Atlas AI home">
          <Logo />
          <span className="hidden border-l border-border pl-2 text-[15px] text-muted sm:inline">Docs</span>
        </Link>
        <div className="flex flex-1 justify-center">
          <button
            type="button"
            onClick={() => setSearch(true)}
            className="hidden h-10 w-full max-w-[400px] items-center gap-2.5 rounded-full bg-surface px-4 text-sm text-subtle transition-colors hover:bg-surface-2 md:flex"
          >
            <Search className="size-4" aria-hidden="true" />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="font-mono text-[11px]">Ctrl K</kbd>
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setSearch(true)} className="grid size-10 place-items-center rounded-full hover:bg-surface md:hidden" aria-label="Search the docs">
            <Search className="size-[18px]" aria-hidden="true" />
          </button>
          <div className="hidden items-center gap-2 sm:flex">
            <Link to="/contact" className="btn btn-light btn-sm">
              Support
            </Link>
            <Link to={APP_LINKS.register} className="btn btn-teal btn-sm">
              Start using Atlas AI <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
      <div className="mx-auto flex h-11 max-w-[1440px] items-stretch gap-6 overflow-x-auto px-4 text-[14.5px] lg:px-6">
        <button type="button" onClick={onMenu} className="flex shrink-0 items-center gap-1.5 text-fg lg:hidden" aria-controls="docs-drawer">
          <Menu className="size-4" aria-hidden="true" /> Menu
        </button>
        {TABS.map((t) => {
          const on = t.href === '/docs' ? pathname.startsWith('/docs') : pathname === t.href;
          return (
            <Link
              key={t.href}
              to={t.href}
              aria-current={on ? 'page' : undefined}
              className={cn('flex shrink-0 items-center border-b-2 transition-colors', on ? 'border-fg font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}
            >
              {t.label}
            </Link>
          );
        })}
        <Link to="/changelog" className="ml-auto flex shrink-0 items-center border-b-2 border-transparent text-muted hover:text-fg">
          Changelog
        </Link>
      </div>
      {search && <SearchDialog onClose={() => setSearch(false)} />}
    </header>
  );
}

/* ---------------------------------------------------------------- Sidebar */

function DocNav({ onPick }: { onPick?: () => void }) {
  return (
    <nav aria-label="Documentation" className="space-y-6">
      {DOC_SECTIONS.map((s, i) => (
        <div key={s} className={cn(i > 0 && 'border-t border-border pt-6')}>
          <p className="mb-1.5 px-3 text-[13.5px] font-semibold text-fg">{s}</p>
          <ul className="space-y-px">
            {DOCS.filter((d) => d.section === s).map((d) => {
              const Icon = iconFor(d.slug);
              return (
                <li key={d.slug}>
                  <NavLink
                    to={`/docs/${d.slug}`}
                    onClick={onPick}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-[14.5px] transition-colors',
                        isActive ? 'bg-accent-soft font-medium text-fg' : 'text-fg/70 hover:bg-surface hover:text-fg',
                      )
                    }
                  >
                    <Icon className="size-4 shrink-0 opacity-70" aria-hidden="true" />
                    {d.title}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ Frame */

const HEADER_H = 109; // two header rows plus the border

function DocsFrame({ children, toc }: { children: ReactNode; toc?: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);
  return (
    <>
      <DocsHeader onMenu={() => setDrawer(true)} />
      {drawer && (
        <div className="fixed inset-0 z-[70] lg:hidden" role="dialog" aria-modal="true" aria-label="Documentation menu" id="docs-drawer">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[min(320px,86vw)] flex-col bg-bg shadow-2xl">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <span className="font-medium">Documentation</span>
              <button type="button" onClick={() => setDrawer(false)} className="flex size-9 items-center justify-center rounded-lg hover:bg-surface" aria-label="Close menu" autoFocus>
                <X className="size-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <DocNav onPick={() => setDrawer(false)} />
            </div>
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-[1440px]">
        <aside className="hidden w-[280px] shrink-0 border-r border-border lg:block">
          <div className="scroll-thin sticky overflow-y-auto px-3 py-6" style={{ top: HEADER_H, height: `calc(100dvh - ${HEADER_H}px)` }}>
            <DocNav />
          </div>
        </aside>
        <div className="min-w-0 flex-1 px-4 py-10 sm:px-8 lg:px-14 lg:py-12">
          <div className="mx-auto flex max-w-[1060px] gap-14">
            <div className="max-w-[760px] min-w-0 flex-1">{children}</div>
            {toc && <aside className="hidden w-[200px] shrink-0 xl:block">{toc}</aside>}
          </div>
        </div>
      </div>
    </>
  );
}

function CopyPage({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <button
      type="button"
      className="btn btn-light btn-sm shrink-0"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          window.clearTimeout(t.current);
          t.current = window.setTimeout(() => setDone(false), 1600);
        }
      }}
    >
      {done ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      {done ? 'Copied' : 'Copy page'}
    </button>
  );
}

/* ------------------------------------------------------------------ Pages */

export function DocsIndexPage() {
  const m = PAGES.find((p) => p.path === '/docs')!;
  return (
    <>
      <Seo title={m.title} description={m.description} path="/docs" />
      <DocsFrame>
        <h1 className="text-[clamp(2rem,1.6rem+1.6vw,2.75rem)] leading-tight font-semibold tracking-tight">Atlas AI documentation</h1>
        <p className="mt-3 text-[17px] leading-relaxed text-muted">Guides for every part of Atlas AI, from creating an account to Deep Research and Voice Mode.</p>

        <div className="docs-callout mt-10 flex flex-col gap-6 rounded-2xl px-6 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <p className="text-[22px] font-semibold tracking-tight">New to Atlas AI?</p>
            <p className="mt-1 text-[15px] opacity-80">Create an account and send your first message in a few minutes.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link to="/docs/getting-started" className="btn btn-light btn-sm">
              Read the quickstart
            </Link>
            <Link to={APP_LINKS.register} className="btn btn-dark btn-sm">
              Create an account
            </Link>
          </div>
        </div>

        <div className="mt-14 space-y-14">
          {DOC_SECTIONS.map((s) => (
            <section key={s} aria-labelledby={`sec-${s}`}>
              <h2 id={`sec-${s}`} className="text-[20px] font-semibold tracking-tight">
                {s}
              </h2>
              <ul className="mt-4 grid gap-x-10 sm:grid-cols-2">
                {DOCS.filter((d) => d.section === s).map((d) => {
                  const Icon = iconFor(d.slug);
                  return (
                    <li key={d.slug}>
                      <Link to={`/docs/${d.slug}`} className="group flex h-full gap-3 border-t border-border py-4">
                        <Icon className="mt-0.5 size-4.5 shrink-0 text-accent" aria-hidden="true" />
                        <span>
                          <span className="block font-medium transition-colors group-hover:text-accent">{d.title}</span>
                          <span className="mt-1 block text-sm leading-relaxed text-muted">{d.summary}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </DocsFrame>
    </>
  );
}

function Toc({ doc }: { doc: DocArticle }) {
  const heads = docHeadings(doc.body);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const els = heads.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: '-120px 0px -65% 0px' },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [doc.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  if (heads.length < 2) return null;
  return (
    <nav aria-label="On this page" className="sticky" style={{ top: HEADER_H + 40 }}>
      <p className="text-[13px] font-semibold text-fg">On this page</p>
      <ul className="mt-3 space-y-1.5 border-l border-border">
        {heads.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                history.replaceState(null, '', `#${h.id}`);
              }}
              className={cn('-ml-px block border-l py-0.5 text-[13px] leading-snug', h.level === 3 ? 'pl-6' : 'pl-3', active === h.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-fg')}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DocArticlePage() {
  const { slug } = useParams();
  const idx = DOCS.findIndex((d) => d.slug === slug);
  if (idx < 0) return <NotFoundPage />;
  const doc = DOCS[idx];
  const prev = DOCS[idx - 1];
  const next = DOCS[idx + 1];
  return (
    <>
      <Seo title={doc.title} description={doc.summary} path={`/docs/${doc.slug}`} type="article" />
      <DocsFrame toc={<Toc doc={doc} />}>
        <article>
          <p className="text-sm font-medium text-accent">{doc.section}</p>
          <div className="mt-2 flex items-start justify-between gap-4">
            <h1 className="text-[clamp(2rem,1.6rem+1.6vw,2.75rem)] leading-tight font-semibold tracking-tight text-balance">{doc.title}</h1>
            <div className="mt-1.5 hidden sm:block">
              <CopyPage text={`# ${doc.title}\n\n${doc.summary}\n\n${doc.body}`} />
            </div>
          </div>
          <p className="mt-3 text-[17px] leading-relaxed text-muted">{doc.summary}</p>
          <div className="mt-10">
            <SiteMarkdown content={doc.body} />
          </div>
        </article>
        <nav aria-label="Previous and next" className="mt-16 grid gap-6 border-t border-border pt-8 sm:grid-cols-2">
          {prev ? (
            <Link to={`/docs/${prev.slug}`} className="group">
              <span className="flex items-center gap-1 text-xs text-muted">
                <ArrowLeft className="size-3.5" aria-hidden="true" /> Previous
              </span>
              <span className="mt-1 block font-medium transition-colors group-hover:text-accent">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link to={`/docs/${next.slug}`} className="group text-right">
              <span className="flex items-center justify-end gap-1 text-xs text-muted">
                Next <ArrowRight className="size-3.5" aria-hidden="true" />
              </span>
              <span className="mt-1 block font-medium transition-colors group-hover:text-accent">{next.title}</span>
            </Link>
          )}
        </nav>
        <p className="mt-8 text-sm text-muted">
          Something unclear or out of date?{' '}
          <Link to="/contact" className="text-accent hover:underline">
            Tell us
          </Link>
          .
        </p>
      </DocsFrame>
    </>
  );
}

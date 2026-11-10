import { Check, Link2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cn, copyText } from '@/lib/utils';
import { BLOG_CATEGORIES, POSTS, readingMinutes, type BlogPost } from '../content/blog';
import { PAGES, SITE_URL } from '../content/site';
import { Seo } from '../layout/Seo';
import { SiteMarkdown } from '../layout/SiteMarkdown';
import { Breadcrumbs, Container, PageHero, PhotoCredit, Reveal, SitePhoto, fmtDate } from '../layout/ui';
import { NotFoundPage } from './InfoPages';

function PostMeta({ post }: { post: BlogPost }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      <time dateTime={post.date}>{fmtDate(post.date)}</time>
      <span aria-hidden="true">·</span>
      <span>{readingMinutes(post.body)} min read</span>
      <span aria-hidden="true">·</span>
      <span>{post.author}</span>
    </p>
  );
}

function PostCard({ post }: { post: BlogPost }) {
  return (
    <Link to={`/blog/${post.slug}`} className="group block rounded-2xl">
      <div className="aspect-[3/2] overflow-hidden rounded-2xl bg-surface">
        <SitePhoto photo={post.image} zoom sizes="(min-width: 1024px) 400px, (min-width: 640px) 50vw, 100vw" />
      </div>
      <p className="t-eyebrow mt-5 text-accent">{post.category}</p>
      <h3 className="mt-2 text-[20px] leading-snug font-semibold tracking-tight text-balance transition-colors group-hover:text-accent">{post.title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">{post.excerpt}</p>
      <div className="mt-3">
        <PostMeta post={post} />
      </div>
    </Link>
  );
}

export function BlogIndexPage() {
  const m = PAGES.find((p) => p.path === '/blog')!;
  const [cat, setCat] = useState<string>('All');
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return POSTS.filter((p) => (cat === 'All' || p.category === cat) && (!t || `${p.title} ${p.excerpt} ${p.body}`.toLowerCase().includes(t)));
  }, [cat, q]);
  const [lead, ...rest] = list;
  return (
    <>
      <Seo title={m.title} description={m.description} path="/blog" />
      <PageHero crumbs={[{ label: 'Home', href: '/' }, { label: 'Blog' }]} eyebrow="Blog" title="The Atlas AI blog." lead="How Atlas AI works, practical guides for getting more from it, and the thinking behind how it is built." />
      <Container className="py-12 sm:py-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div role="group" aria-label="Filter by category" className="-mx-1 flex flex-wrap gap-1">
            {['All', ...BLOG_CATEGORIES].map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={cat === c}
                onClick={() => setCat(c)}
                className={cn('rounded-full px-3.5 py-1.5 text-sm transition-colors', cat === c ? 'bg-fg text-bg' : 'text-fg/70 hover:bg-fg/[0.05] hover:text-fg')}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search posts" aria-label="Search posts" className="h-10 w-full rounded-full border border-border bg-transparent pr-4 pl-9 text-sm outline-none focus:border-accent" />
          </div>
        </div>
        {list.length ? (
          <>
            {lead && (
              <Reveal className="mt-10">
                <Link to={`/blog/${lead.slug}`} className="group grid items-center gap-8 rounded-3xl lg:grid-cols-[1.25fr_1fr] lg:gap-14">
                  <div className="aspect-[3/2] overflow-hidden rounded-3xl bg-surface">
                    <SitePhoto photo={lead.image} zoom priority sizes="(min-width: 1024px) 680px, 100vw" />
                  </div>
                  <div>
                    <p className="t-eyebrow text-accent">{lead.category}</p>
                    <h2 className="t-h2 mt-3 text-balance transition-colors group-hover:text-accent">{lead.title}</h2>
                    <p className="t-lead mt-4 text-muted">{lead.excerpt}</p>
                    <div className="mt-6">
                      <PostMeta post={lead} />
                    </div>
                  </div>
                </Link>
              </Reveal>
            )}
            {rest.length > 0 && (
              <ul className={`mt-16 grid gap-x-8 gap-y-14 border-t border-border pt-14 sm:grid-cols-2${rest.length > 2 ? ' lg:grid-cols-3' : ''}`}>
                {rest.map((p, i) => (
                  <li key={p.slug}>
                    <Reveal delay={i * 0.05}>
                      <PostCard post={p} />
                    </Reveal>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="mt-10 text-muted" aria-live="polite">
            No posts match your search.
          </p>
        )}
      </Container>
    </>
  );
}

function Share({ post }: { post: BlogPost }) {
  const url = `${SITE_URL}/blog/${post.slug}`;
  const [copied, setCopied] = useState(false);
  const links = [
    { label: 'X', href: `https://x.com/intent/post?text=${encodeURIComponent(post.title)}&url=${encodeURIComponent(url)}` },
    { label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}` },
    { label: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(`${post.title} ${url}`)}` },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-sm text-muted">Share</span>
      <button
        type="button"
        className="btn btn-light btn-sm"
        onClick={async () => {
          if (await copyText(url)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }
        }}
      >
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Link2 className="size-4" aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy link'}
      </button>
      {links.map((l) => (
        <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="btn btn-light btn-sm">
          {l.label}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ))}
    </div>
  );
}

export function BlogPostPage() {
  const { slug } = useParams();
  const post = POSTS.find((p) => p.slug === slug);
  if (!post) return <NotFoundPage />;
  const related = POSTS.filter((p) => p.slug !== post.slug).sort((a, b) => Number(b.category === post.category) - Number(a.category === post.category)).slice(0, 2);
  return (
    <>
      <Seo title={post.title} description={post.excerpt} path={`/blog/${post.slug}`} type="article" />
      <article>
        <Container narrow className="pt-10 sm:pt-14">
          <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Blog', href: '/blog' }, { label: post.title }]} />
          <p className="t-eyebrow mt-10 text-accent">{post.category}</p>
          <h1 className="t-h1 mt-4 text-balance">{post.title}</h1>
          <p className="t-lead mt-4 text-muted">{post.excerpt}</p>
          <div className="mt-6">
            <PostMeta post={post} />
          </div>
        </Container>
        <Container className="mt-10 max-w-5xl">
          <figure>
            <div className="aspect-[3/2] overflow-hidden rounded-3xl bg-surface sm:aspect-[16/9]">
              <SitePhoto photo={post.image} priority sizes="(min-width: 1024px) 1000px, 100vw" />
            </div>
            <figcaption>
              <PhotoCredit photo={post.image} className="mt-3" />
            </figcaption>
          </figure>
        </Container>
        <Container narrow className="py-12 sm:py-16">
          <SiteMarkdown content={post.body} />
          <div className="mt-14 border-t border-border pt-8">
            <Share post={post} />
          </div>
        </Container>
      </article>
      {related.length > 0 && (
        <section className="border-t border-border py-16 sm:py-20" aria-labelledby="related">
          <Container>
            <h2 id="related" className="t-h3">
              More from the blog
            </h2>
            <ul className="mt-10 grid gap-x-8 gap-y-12 sm:grid-cols-2">
              {related.map((p) => (
                <li key={p.slug}>
                  <PostCard post={p} />
                </li>
              ))}
            </ul>
          </Container>
        </section>
      )}
    </>
  );
}

/**
 * Public website: every link in the navigation, footer, help topics, feature
 * cards and docs resolves to a real route; the sitemap and robots rules keep
 * the right things in and out; docs search finds articles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POSTS } from '../src/features/site/content/blog.js';
import { DOCS, docHeadings, searchDocs, slugify } from '../src/features/site/content/docs.js';
import { FEATURES } from '../src/features/site/content/features.js';
import { HELP_TOPICS } from '../src/features/site/content/help.js';
import { INTEGRATIONS } from '../src/features/site/content/integrations.js';
import { POLICIES } from '../src/features/site/content/policies.js';
import { headTags, robotsTxt, seoRoutes, sitemapPaths, sitemapXml } from '../src/features/site/content/seo.js';
import { FOOTER, NAV, PAGES, SITE_URL } from '../src/features/site/content/site.js';

/** Static route paths declared in App.tsx, plus the docs and blog articles. */
function knownPaths(): Set<string> {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const paths = new Set<string>(['/']);
  for (const m of app.matchAll(/path="([^"]+)"/g)) {
    const p = m[1].startsWith('/') ? m[1] : `/${m[1]}`;
    if (!p.includes(':') && !p.includes('*')) paths.add(p);
  }
  for (const d of DOCS) paths.add(`/docs/${d.slug}`);
  for (const p of POSTS) paths.add(`/blog/${p.slug}`);
  return paths;
}

function resolves(href: string, paths: Set<string>): boolean {
  if (/^(https?:|mailto:)/.test(href)) return true;
  const [path] = href.split('#');
  return paths.has(path);
}

describe('site links', () => {
  const paths = knownPaths();
  const internal = (hrefs: string[]) => hrefs.filter((h) => h.startsWith('/'));

  it('navigation links resolve', () => {
    const hrefs = NAV.flatMap((n) => ('columns' in n ? n.columns.flatMap((c) => c.links.map((l) => l.href)) : [n.href]));
    for (const h of hrefs) expect(resolves(h, paths), h).toBe(true);
  });

  it('footer links resolve', () => {
    for (const h of FOOTER.flatMap((c) => c.links.map((l) => l.href))) expect(resolves(h, paths), h).toBe(true);
  });

  it('feature and help links resolve', () => {
    for (const f of FEATURES) if (f.doc) expect(resolves(f.doc, paths), f.doc).toBe(true);
    for (const t of HELP_TOPICS) for (const q of t.faqs) if (q.doc) expect(resolves(q.doc, paths), q.doc).toBe(true);
  });

  it('links inside docs, posts and policies resolve', () => {
    const bodies = [...DOCS.map((d) => d.body), ...POSTS.map((p) => p.body), ...Object.values(POLICIES).map((p) => p.body)];
    const hrefs = bodies.flatMap((b) => [...b.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]));
    expect(internal(hrefs).length).toBeGreaterThan(10);
    for (const h of hrefs) expect(resolves(h, paths), h).toBe(true);
  });

  it('every page has metadata and every integration has a site', () => {
    for (const p of PAGES) {
      expect(p.title.length).toBeGreaterThan(2);
      expect(p.description.length).toBeGreaterThan(30);
      expect(p.description.length).toBeLessThanOrEqual(170);
    }
    for (const i of INTEGRATIONS) expect(i.site).toMatch(/^https:\/\//);
  });
});

describe('sitemap and robots', () => {
  it('includes public pages, docs and posts, excludes app routes', () => {
    const paths = sitemapPaths();
    expect(paths).toContain('/');
    expect(paths).toContain('/about');
    expect(paths).toContain('/docs/getting-started');
    expect(paths).toContain('/privacy');
    for (const p of POSTS) expect(paths).toContain(`/blog/${p.slug}`);
    for (const p of ['/login', '/settings', '/admin/users', '/c/abc', '/404']) expect(paths).not.toContain(p);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('writes valid XML with absolute URLs', () => {
    const xml = sitemapXml('2026-11-09');
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain(`<loc>${SITE_URL}/about</loc>`);
    expect(xml).not.toContain('<loc>/');
  });

  it('robots blocks the app and API but allows the public help centre', () => {
    const r = robotsTxt();
    expect(r).toContain('Disallow: /api/');
    expect(r).toContain('Disallow: /admin');
    expect(r).toContain('Allow: /help-centre');
    expect(r).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });

  it('every route has unique title and canonical', () => {
    const routes = seoRoutes();
    const titles = routes.map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length);
    const tags = headTags(routes.find((r) => r.path === '/about')!);
    expect(tags).toContain('<title>About Atlas AI</title>');
    expect(headTags(routes.find((r) => r.path === '/features')!)).toContain('<title>Features · Atlas AI</title>');
    expect(tags).toContain(`<link rel="canonical" href="${SITE_URL}/about" />`);
    const post = routes.find((r) => r.path.startsWith('/blog/'))!;
    expect(headTags(post)).not.toContain('noindex');
    expect(headTags(post)).toContain('"@type":"Article"');
    expect(headTags(routes[0])).toContain('"@type":"Organization"');
  });
});

describe('docs', () => {
  it('search finds articles by title, heading and body', () => {
    expect(searchDocs('voice mode')[0].slug).toBe('voice-mode');
    expect(searchDocs('pdf').map((d) => d.slug)).toContain('documents');
    expect(searchDocs('interrupting').map((d) => d.slug)).toContain('voice-mode');
    expect(searchDocs('')).toEqual([]);
    expect(searchDocs('zzzzqqq')).toEqual([]);
  });

  it('headings produce stable, unique ids', () => {
    for (const d of DOCS) {
      const ids = docHeadings(d.body).map((h) => h.id);
      expect(new Set(ids).size, d.slug).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    }
    expect(slugify('Web search & Deep Research')).toBe('web-search-deep-research');
  });

  it('slugs are unique and every section is used', () => {
    const slugs = DOCS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(DOCS.some((d) => d.slug === 'developers' && /not.*public.*API/i.test(d.body))).toBe(true);
  });
});

describe('content honesty', () => {
  it('has no placeholder labels or invented team on public pages', () => {
    const bodies = [...DOCS.map((d) => d.body), ...POSTS.map((p) => `${p.title} ${p.excerpt} ${p.author} ${p.body}`), ...Object.values(POLICIES).map((p) => p.body)].join(' ');
    expect(bodies).not.toMatch(/awaiting approval|lorem ipsum|placeholder|Atlas AI team/i);
  });

  it('every post has a credited photo that exists at both widths', () => {
    for (const p of POSTS) {
      expect(p.image.creditUrl).toMatch(/^https:\/\/unsplash\.com\/photos\//);
      for (const w of [800, 1600]) expect(existsSync(new URL(`../public${p.image.src}-${w}.webp`, import.meta.url)), `${p.image.src}-${w}`).toBe(true);
    }
  });
});

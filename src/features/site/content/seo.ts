/**
 * Build-time SEO data for the public website: every public route with its
 * title and description, the sitemap and robots.txt. Used by
 * dev/site-prerender.ts (static HTML per route) and by the tests.
 * Plain data only (no React), so Node can import it.
 */
import { POSTS } from './blog.js';
import { DOCS } from './docs.js';
import { fullTitle, OG_IMAGE, PAGES, SITE_DESCRIPTION, SITE_NAME, SITE_URL, type PageMeta } from './site.js';

export interface SeoRoute extends PageMeta {
  type: 'website' | 'article';
  /** breadcrumb trail for JSON-LD */
  crumbs?: { name: string; path: string }[];
  date?: string;
}

export function seoRoutes(): SeoRoute[] {
  const pages: SeoRoute[] = PAGES.map((p) => ({ ...p, type: 'website' }));
  const docs: SeoRoute[] = DOCS.map((d) => ({
    path: `/docs/${d.slug}`,
    title: d.title,
    description: d.summary,
    type: 'article',
    crumbs: [
      { name: 'Docs', path: '/docs' },
      { name: d.title, path: `/docs/${d.slug}` },
    ],
  }));
  const posts: SeoRoute[] = POSTS.map((p) => ({
    path: `/blog/${p.slug}`,
    title: p.title,
    description: p.excerpt,
    type: 'article',
    date: p.date,
    crumbs: [
      { name: 'Blog', path: '/blog' },
      { name: p.title, path: `/blog/${p.slug}` },
    ],
  }));
  return [...pages, ...docs, ...posts];
}

/** Paths that belong in the sitemap: public, indexable pages only. */
export function sitemapPaths(): string[] {
  return seoRoutes()
    .filter((r) => !r.noindex)
    .map((r) => r.path);
}

export function sitemapXml(lastmod: string): string {
  const urls = sitemapPaths()
    .map((p) => `  <url><loc>${SITE_URL}${p === '/' ? '/' : p}</loc><lastmod>${lastmod}</lastmod></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** The app, admin screens and the API are not for search engines. */
export const ROBOTS_DISALLOW = [
  '/api/',
  '/__/',
  '/c/',
  '/admin',
  '/settings',
  '/memory',
  '/projects',
  '/saved',
  '/images',
  '/documents',
  '/knowledge',
  '/support',
  '/notifications',
  '/help',
  '/verify',
  '/verify-phone',
  '/request-access',
  '/consent',
  '/denied',
  '/reset',
];

export function robotsTxt(): string {
  // "/help" would also block "/help-centre", so allow it explicitly.
  return ['User-agent: *', 'Allow: /', 'Allow: /help-centre', ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`), '', `Sitemap: ${SITE_URL}/sitemap.xml`, ''].join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JSON-LD for a route. */
export function jsonLd(r: SeoRoute): object[] {
  const out: object[] = [];
  if (r.path === '/') {
    out.push(
      { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: SITE_URL, logo: `${SITE_URL}/pwa-512.png` },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: SITE_URL, description: SITE_DESCRIPTION },
    );
  }
  if (r.crumbs) {
    out.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [{ name: 'Home', path: '/' }, ...r.crumbs].map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: `${SITE_URL}${c.path}` })),
    });
  }
  if (r.path.startsWith('/blog/') && r.date) {
    out.push({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: r.title,
      description: r.description,
      datePublished: r.date,
      author: { '@type': 'Organization', name: 'Atlas AI' },
      image: `${SITE_URL}${OG_IMAGE}`,
    });
  }
  return out;
}

/** Head tags for a route, replacing the defaults in index.html. */
export function headTags(r: SeoRoute): string {
  const title = fullTitle(r.title);
  const url = `${SITE_URL}${r.path === '/' ? '/' : r.path}`;
  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(r.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    r.noindex ? '<meta name="robots" content="noindex, follow" />' : '',
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="${r.type}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(r.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${SITE_URL}${OG_IMAGE}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(r.description)}" />`,
    `<meta name="twitter:image" content="${SITE_URL}${OG_IMAGE}" />`,
    ...jsonLd(r).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`),
  ];
  return tags.filter(Boolean).join('\n    ');
}

/** Text for visitors without JavaScript (and simple crawlers). */
export function noscriptBody(r: SeoRoute): string {
  const links = PAGES.filter((p) => p.path !== '/' && !p.noindex)
    .map((p) => `<a href="${p.path}">${esc(p.crumb ?? p.title)}</a>`)
    .join(' · ');
  return `<noscript><main style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px"><h1>${esc(fullTitle(r.title))}</h1><p>${esc(r.description)}</p><p>Atlas AI needs JavaScript enabled.</p><nav>${links}</nav></main></noscript>`;
}

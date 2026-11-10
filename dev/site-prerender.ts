/**
 * Build step for the public website: after Vite writes dist/, create
 *   dist/<route>/index.html  for every public route, with its own title,
 *                            description, canonical, social tags and JSON-LD
 *   dist/sitemap.xml         indexable public pages only
 *   dist/robots.txt          keeps the app, admin and API out of search
 * Vercel serves these files before the SPA rewrite, so crawlers and link
 * previews get the right tags; the React app then takes over as usual.
 * No new dependencies, no network.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { headTags, noscriptBody, robotsTxt, seoRoutes, sitemapXml } from '../src/features/site/content/seo.js';

export function sitePrerender(): Plugin {
  let outDir = 'dist';
  return {
    name: 'atlas-site-prerender',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const template = readFileSync(join(outDir, 'index.html'), 'utf8');
      const strip = (html: string) =>
        html
          .replace(/<title>[\s\S]*?<\/title>\s*/, '')
          .replace(/<meta name="description"[^>]*>\s*/, '')
          .replace(/<meta property="og:[^>]*>\s*/g, '')
          .replace(/<meta name="twitter:[^>]*>\s*/g, '');
      const base = strip(template);
      const routes = seoRoutes();
      for (const r of routes) {
        const html = base
          .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    ${headTags(r)}`)
          .replace(/<noscript>[\s\S]*?<\/noscript>/, noscriptBody(r));
        if (r.path === '/') {
          writeFileSync(join(outDir, 'index.html'), html);
          continue;
        }
        const dir = join(outDir, ...r.path.split('/').filter(Boolean));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.html'), html);
      }
      writeFileSync(join(outDir, 'sitemap.xml'), sitemapXml(new Date().toISOString().slice(0, 10)));
      writeFileSync(join(outDir, 'robots.txt'), robotsTxt());
      this.info?.(`site prerender: ${routes.length} pages, sitemap.xml, robots.txt`);
    },
  };
}

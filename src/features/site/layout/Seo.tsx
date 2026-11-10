import { useEffect } from 'react';
import { fullTitle, OG_IMAGE, SITE_URL } from '../content/site';

function setMeta(attr: 'name' | 'property', key: string, value: string | null) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (value === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = value;
}

function setCanonical(href: string | null) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (href === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  el.href = href;
}

/**
 * Title, description, canonical and social tags for a public page, set at
 * runtime. The build also writes them into static HTML for crawlers
 * (dev/site-prerender.ts). Restores the app defaults on leave.
 */
export function Seo({ title, description, path, noindex, type = 'website' }: { title: string; description: string; path: string; noindex?: boolean; type?: 'website' | 'article' }) {
  useEffect(() => {
    const t = fullTitle(title);
    const url = `${SITE_URL}${path === '/' ? '/' : path}`;
    document.title = t;
    setMeta('name', 'description', description);
    setMeta('name', 'robots', noindex ? 'noindex, follow' : null);
    setMeta('property', 'og:title', t);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', url);
    setMeta('property', 'og:type', type);
    setMeta('property', 'og:image', `${SITE_URL}${OG_IMAGE}`);
    setMeta('name', 'twitter:card', 'summary_large_image');
    setMeta('name', 'twitter:title', t);
    setMeta('name', 'twitter:description', description);
    setCanonical(url);
    return () => {
      document.title = 'Atlas AI';
      setMeta('name', 'robots', null);
      setCanonical(null);
    };
  }, [title, description, path, noindex, type]);
  return null;
}

import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Suspense, useEffect, useRef, type ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ANNOUNCEMENT } from '../content/site';
import '../site.css';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';

function AnnouncementBar() {
  if (!ANNOUNCEMENT.text) return null;
  return (
    <div className="night relative z-[51] text-[13.5px]">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2.5 text-center">
        <span className="text-fg/90">{ANNOUNCEMENT.text}</span>
        {ANNOUNCEMENT.href && (
          <Link to={ANNOUNCEMENT.href} className="group inline-flex items-center gap-1 rounded font-medium text-accent">
            {ANNOUNCEMENT.linkLabel}
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Frame for every public page: its own scroll container (the app frame does
 * not scroll), skip link, announcement, header, page and footer. Scrolls to
 * the top on navigation, or to the #anchor when the link has one.
 */
export default function SiteLayout({ children }: { children?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const { pathname, hash } = useLocation();
  const reduce = useReducedMotion();
  // the docs draw their own header (search, tabs) like a docs site
  const isDocs = pathname === '/docs' || pathname.startsWith('/docs/');

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (hash) {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target) {
        // wait a frame so lazy content has laid out
        requestAnimationFrame(() => target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }));
        return;
      }
    }
    el.scrollTo({ top: 0 });
  }, [pathname, hash, reduce]);

  return (
    <div ref={scroller} className="site scroll-thin touch-scroll h-full overflow-x-hidden overflow-y-auto" style={{ scrollPaddingTop: isDocs ? '8rem' : '5.5rem' }}>
      <a
        href="#main"
        className="sr-only z-[100] rounded-lg bg-fg px-4 py-2 text-sm text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <AnnouncementBar />
      {!isDocs && <PublicHeader scrollRef={scroller} />}
      <motion.main
        key={pathname}
        id="main"
        tabIndex={-1}
        className="outline-none"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
      >
        {/* page chunks load inside the frame, so the header and footer stay put */}
        <Suspense fallback={<div className="min-h-[70vh]" />}>{children ?? <Outlet />}</Suspense>
      </motion.main>
      <PublicFooter />
    </div>
  );
}

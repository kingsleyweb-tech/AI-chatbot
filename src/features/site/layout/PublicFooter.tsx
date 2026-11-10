import { ArrowUpRight, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { APP_LINKS, FOOTER, SITE_EMAIL, SITE_TAGLINE } from '../content/site';
import { Container } from './ui';

export function PublicFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border bg-surface/60" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <Container className="py-14 sm:py-16">
        <div className="grid gap-12 lg:grid-cols-[1.3fr_repeat(4,1fr)] lg:gap-8">
          <div className="max-w-xs">
            <Link to="/" aria-label="Atlas AI home" className="inline-block rounded-lg">
              <Logo />
            </Link>
            <p className="mt-4 text-[15px] font-medium text-fg">{SITE_TAGLINE}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">An AI assistant for thinking, creating and discovering.</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link to={APP_LINKS.register} className="btn btn-dark btn-sm">
                Start using Atlas AI
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4 lg:contents">
            {FOOTER.map((col) => (
              <nav key={col.heading} aria-label={col.heading}>
                <h2 className="t-eyebrow text-subtle">{col.heading}</h2>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((l) => (
                    <li key={l.href}>
                      <Link to={l.href} className="rounded text-sm text-fg/75 transition-colors hover:text-fg">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-border pt-6 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} Atlas AI. All rights reserved.</p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <a href={`mailto:${SITE_EMAIL}`} className="inline-flex items-center gap-1.5 rounded hover:text-fg">
              <Mail className="size-4" aria-hidden="true" />
              Email us
            </a>
            <Link to="/status" className="inline-flex items-center gap-1.5 rounded hover:text-fg">
              Status <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </Container>
    </footer>
  );
}

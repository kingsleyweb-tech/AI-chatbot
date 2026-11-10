import { Link } from 'react-router-dom';
import { AnalyticsSwitch } from '@/components/AnalyticsConsent';
import { analyticsAvailable } from '@/lib/analyticsConsent';
import { useAuth } from '@/state/auth';
import { PRIVACY_VERSION, TERMS_VERSION } from '@shared/legal';
import { PAGES } from '../site/content/site';
import { Seo } from '../site/layout/Seo';
import { Container, PageHero } from '../site/layout/ui';
import { slugify } from '../site/content/docs';
import { LEGAL_UPDATED, PRIVACY, TERMS } from './content';

/** Render text with web addresses and email addresses as links. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s)]+[^\s).,]|[\w.+-]+@[\w-]+\.[\w.]+\w)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
        const href = p.startsWith('https://') ? p : `mailto:${p}`;
        return (
          <a key={i} href={href} target={href.startsWith('https') ? '_blank' : undefined} rel="noreferrer" className="break-words">
            {p}
          </a>
        );
      })}
    </>
  );
}

/**
 * Privacy Policy and Terms of Use (the live, accepted versions from
 * content.ts). Public, rendered inside the website layout; linked from the
 * sign-in screen, consent screen and Settings.
 */
export default function LegalPage({ doc }: { doc: 'privacy' | 'terms' }) {
  const d = doc === 'privacy' ? PRIVACY : TERMS;
  const { access } = useAuth();
  const inApp = access === 'allowed';
  const meta = PAGES.find((p) => p.path === `/${doc}`)!;
  const ids = d.sections.map((s, i) => `${i + 1}-${slugify(s.heading)}`);

  return (
    <>
      <Seo title={meta.title} description={meta.description} path={meta.path} />
      <PageHero crumbs={[{ label: 'Home', href: '/' }, { label: d.title }]} eyebrow="Legal" title={d.title}>
        <p className="text-sm text-muted">
          Version {doc === 'privacy' ? PRIVACY_VERSION : TERMS_VERSION} · Last updated: {LEGAL_UPDATED}
        </p>
      </PageHero>

      <Container className="py-12 sm:py-16">
        <div className="grid gap-12 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-16">
          <nav aria-label="Sections" className="hidden lg:block">
            <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">
              <p className="t-eyebrow text-subtle">Contents</p>
              <ol className="mt-3 space-y-1.5 text-[13px]">
                {d.sections.map((s, i) => (
                  <li key={s.heading}>
                    <a href={`#${ids[i]}`} className="block rounded text-muted hover:text-fg">
                      {i + 1}. {s.heading}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </nav>

          <div className="prose-site">
            <p>{d.intro}</p>
            {d.sections.map((s, i) => (
              <section key={s.heading}>
                <h2 id={ids[i]}>
                  {i + 1}. {s.heading}
                </h2>
                {s.paragraphs?.map((p) => (
                  <p key={p}>
                    <Linked text={p} />
                  </p>
                ))}
                {s.bullets && (
                  <ul>
                    {s.bullets.map((b) => (
                      <li key={b}>
                        <Linked text={b} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}

            {doc === 'privacy' && analyticsAvailable && (
              <section className="not-prose mt-10 flex items-center justify-between gap-4 rounded-2xl border border-border bg-elevated px-5 py-4">
                <div>
                  <h2 className="!mt-0 !text-base">Your analytics choice</h2>
                  <p className="!mt-0.5 text-sm text-muted">Google Analytics in this browser. Off unless you allow it.</p>
                </div>
                <AnalyticsSwitch />
              </section>
            )}

            <p className="text-sm text-muted">
              See also: {doc === 'privacy' ? <Link to="/terms">Terms of Use</Link> : <Link to="/privacy">Privacy Policy</Link>} · <Link to="/cookies">Cookie Policy</Link>
              {inApp && (
                <>
                  {' · '}
                  <Link to="/settings/about">Back to Settings</Link>
                </>
              )}
            </p>
          </div>
        </div>
      </Container>
    </>
  );
}

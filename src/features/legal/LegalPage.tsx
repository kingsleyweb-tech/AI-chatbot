import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { AnalyticsSwitch } from '@/components/AnalyticsConsent';
import { LogoMark } from '@/components/Logo';
import { analyticsAvailable } from '@/lib/analyticsConsent';
import { useAuth } from '@/state/auth';
import { PRIVACY_VERSION, TERMS_VERSION } from '@shared/legal';
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
          <a key={i} href={href} target={href.startsWith('https') ? '_blank' : undefined} rel="noreferrer" className="break-words text-accent hover:underline">
            {p}
          </a>
        );
      })}
    </>
  );
}

/**
 * Privacy Policy and Terms of Use. Public (no sign-in needed) so they can be
 * linked from the sign-in screen; works inside and outside the app shell.
 */
export default function LegalPage({ doc }: { doc: 'privacy' | 'terms' }) {
  const d = doc === 'privacy' ? PRIVACY : TERMS;
  const navigate = useNavigate();
  const { access } = useAuth();
  const inApp = access === 'allowed';
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate(inApp ? '/settings/about' : '/login'));

  return (
    <div className="scroll-thin touch-scroll h-full overflow-x-hidden overflow-y-auto bg-bg">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/90 pt-safe backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-2 sm:px-4">
          <button type="button" onClick={back} className="tap flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg" aria-label="Back">
            <ArrowLeft className="size-5" />
          </button>
          <LogoMark className="size-6" />
          <span className="truncate text-[15px] font-medium">Atlas AI · {d.title}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-6 pb-safe-12 sm:px-6 sm:pt-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{d.title}</h1>
        <p className="mt-1 text-sm text-muted">
          Version {doc === 'privacy' ? PRIVACY_VERSION : TERMS_VERSION} · Last updated: {LEGAL_UPDATED}
        </p>

        <p className="mt-6 text-[15px] leading-relaxed">{d.intro}</p>

        {d.sections.map((s, i) => (
          <section key={s.heading} className="mt-8">
            <h2 className="text-lg font-semibold tracking-tight">
              {i + 1}. {s.heading}
            </h2>
            {s.paragraphs?.map((p) => (
              <p key={p} className="mt-2 text-[15px] leading-relaxed text-fg/90">
                <Linked text={p} />
              </p>
            ))}
            {s.bullets && (
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-fg/90">
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
          <section className="mt-10 flex items-center justify-between gap-4 rounded-2xl bg-elevated px-4 py-4">
            <div>
              <h2 className="text-sm font-semibold">Your analytics choice</h2>
              <p className="mt-0.5 text-sm text-muted">Google Analytics in this browser. Off unless you allow it.</p>
            </div>
            <AnalyticsSwitch />
          </section>
        )}

        <p className="mt-8 text-sm text-muted">
          See also:{' '}
          {doc === 'privacy' ? (
            <Link to="/terms" className="text-accent hover:underline">
              Terms of Use
            </Link>
          ) : (
            <Link to="/privacy" className="text-accent hover:underline">
              Privacy Policy
            </Link>
          )}
          {inApp && (
            <>
              {' · '}
              <Link to="/help" className="text-accent hover:underline">
                Help Centre
              </Link>
            </>
          )}
        </p>
      </main>
    </div>
  );
}

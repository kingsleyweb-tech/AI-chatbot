import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  Bug,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Compass,
  Eye,
  Handshake,
  HeartHandshake,
  LifeBuoy,
  Lightbulb,
  Mail,
  MessageSquare,
  Scale,
  Search,
  ShieldCheck,
  Accessibility as AccessibilityIcon,
  Globe,
  FileText,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { RELEASES } from '../content/changelog';
import { searchDocs } from '../content/docs';
import { FEATURES } from '../content/features';
import { HELP_TOPICS } from '../content/help';
import { INTEGRATION_CATEGORIES, INTEGRATIONS, type Integration } from '../content/integrations';
import { PHOTOS, type Photo } from '../content/photos';
import { POLICIES, POLICIES_UPDATED, type Policy } from '../content/policies';
import { APP_LINKS, PAGES, SITE_EMAIL } from '../content/site';
import { FinalCta } from '../home/HomePage';
import { DashboardShot } from '../home/DashboardShot';
import { DocumentCard, ImageCard, PhoneMock, ResearchCard, VoiceOrb } from '../home/Previews';
import { FloatCard, FloatCluster } from '../home/Float';
import { Seo } from '../layout/Seo';
import { SiteMarkdown } from '../layout/SiteMarkdown';
import { Badge, Container, PageHero, Reveal, SectionHeading, SitePhoto, fmtDate } from '../layout/ui';

function meta(path: string) {
  const m = PAGES.find((p) => p.path === path);
  if (!m) throw new Error(`No page meta for ${path}`);
  return m;
}
function PageSeo({ path }: { path: string }) {
  const m = meta(path);
  return <Seo title={m.title} description={m.description} path={path} noindex={m.noindex} />;
}
const home = { label: 'Home', href: '/' };

/* ================================================================ About */

const PRINCIPLES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Eye, title: 'Show the evidence', text: 'Web answers carry their sources and news dates are checked, so you can verify instead of trusting.' },
  { icon: Scale, title: 'Honest about limits', text: 'When a search limit is reached, a model is swapped or a document was only partly read, Atlas says so.' },
  { icon: ShieldCheck, title: 'Private by default', text: 'Each account can only reach its own data. Analytics is off until you allow it.' },
  { icon: HeartHandshake, title: 'Built for everyone', text: 'Works on phones and computers, with voice input, read-aloud replies and keyboard access.' },
];

export function AboutPage() {
  const first = RELEASES[RELEASES.length - 1];
  return (
    <>
      <PageSeo path="/about" />
      <PageHero
        crumbs={[home, { label: 'About' }]}
        eyebrow="About Atlas AI"
        title="Built to help people think further."
        lead="Atlas AI brings the tools for understanding and creating (conversation, search, research, documents, images and voice) into one workspace, and is honest about what each answer is built on."
      />
      <section className="py-20 sm:py-24">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:gap-20">
            <Reveal>
              <h2 className="t-h2">Why it exists</h2>
              <div className="prose-site mt-6">
                <p>
                  Getting something done with AI usually means juggling a chatbot, a search engine, a PDF reader, a translator and an image tool, and re-explaining the context every time you switch.
                </p>
                <p>
                  Atlas AI started on {fmtDate(first.date)} with a simple goal: put those tools in one conversation, choose the right one automatically, and show the evidence behind every answer that depends on the web.
                </p>
                <p>
                  It is developed and operated by Anaab Kingsley, based in Ghana, and improves in small, frequent releases that are all listed in the <Link to="/changelog">changelog</Link>.
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.08}>
              <FloatCluster width={560} height={430}>
                <div className="absolute inset-[15%] rounded-full bg-accent/15 blur-3xl" />
                <FloatCard style={{ top: 24, left: 0 }} rotate={-2} depth={14} drift={8} from={{ x: -40, y: 30 }}>
                  <ResearchCard className="w-[280px]" />
                </FloatCard>
                <FloatCard style={{ top: 70, right: 0 }} rotate={3} depth={26} delay={0.15} drift={9} from={{ x: 40, y: 40 }}>
                  <ImageCard className="w-[280px]" />
                </FloatCard>
              </FloatCluster>
            </Reveal>
          </div>
        </Container>
      </section>
      <section className="border-y border-border bg-surface/70 py-20 sm:py-24">
        <Container>
          <SectionHeading eyebrow="Principles" title="What guides every release." />
          <div className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {PRINCIPLES.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={i * 0.05}>
                <div className="h-full border-t border-border pt-6">
                  <Icon className="size-5 text-accent" aria-hidden="true" />
                  <h3 className="mt-4 text-[17px] font-semibold tracking-tight">{title}</h3>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{text}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>
      <section className="py-20 sm:py-24">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
            <SectionHeading eyebrow="How it is built" title="Proven services, carefully combined." lead="Atlas AI is a web app with its own server layer that checks every request before calling an AI or search provider." />
            <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {[
                ['Models', 'Google Gemini first, with free models through OpenRouter.'],
                ['Search', 'Tavily and SerpAPI for the web and the news.'],
                ['Media', 'Cloudflare Workers AI for images, speech and translation; ElevenLabs voices as an option.'],
                ['Platform', 'Firebase for accounts and data, Vercel for hosting.'],
              ].map(([t, d]) => (
                <li key={t} className="border-t border-border pt-5">
                  <p className="t-eyebrow text-subtle">{t}</p>
                  <p className="mt-2 text-[15px] leading-relaxed">{d}</p>
                </li>
              ))}
              <li className="sm:col-span-2">
                <Link to="/integrations" className="inline-flex items-center gap-1 rounded text-sm font-medium text-accent hover:underline">
                  See every integration <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </li>
            </ul>
          </div>
        </Container>
      </section>
      <FinalCta />
    </>
  );
}

/* ============================================================= Features */

/** Large photographic stage with a live product preview on top. */
function Stage({ photo, children, className }: { photo: Photo; children: ReactNode; className?: string }) {
  return (
    <figure className={cn('relative isolate overflow-hidden rounded-[28px] bg-surface', className)}>
      <SitePhoto photo={photo} className="absolute inset-0 -z-10" sizes="(min-width: 1024px) 600px, 100vw" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/55 via-black/20 to-black/10" aria-hidden="true" />
      <div className="flex size-full items-center justify-center p-6" aria-hidden="true">
        {children}
      </div>
      <figcaption className="absolute right-4 bottom-3 text-[11px] text-white/75">
        Photo:{' '}
        <a href={photo.creditUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-white/40 underline-offset-2 hover:text-white">
          {photo.credit} / Unsplash
        </a>
      </figcaption>
    </figure>
  );
}

const VISUALS: Record<string, { photo: Photo; node: ReactNode }> = {
  research: { photo: PHOTOS.research, node: <ResearchCard className="scale-110 sm:scale-[1.3]" /> },
  documents: { photo: PHOTOS.documents, node: <DocumentCard className="scale-110 sm:scale-[1.3]" /> },
  images: { photo: PHOTOS.images, node: <ImageCard className="scale-105 sm:scale-[1.25]" /> },
  voice: {
    photo: PHOTOS.voice,
    node: (
      <div className="night rounded-[28px] px-10 py-8 shadow-2xl sm:scale-110">
        <VoiceOrb className="text-[#cfe9e4]" label="Listening…" />
      </div>
    ),
  },
  translate: { photo: PHOTOS.translate, node: <PhoneMock className="w-[210px] scale-[0.62] sm:scale-[0.8]" /> },
};

export function FeaturesPage() {
  return (
    <>
      <PageSeo path="/features" />
      <PageHero
        crumbs={[home, { label: 'Features' }]}
        eyebrow="Features"
        title="Everything Atlas AI can do today."
        lead="Every feature on this page is live in the app. Nothing here is a preview or a promise."
      >
        <nav aria-label="On this page" className="-mx-1 flex flex-wrap gap-x-1 gap-y-2">
          {FEATURES.map((f) => (
            <a key={f.id} href={`#${f.id}`} className="rounded-full px-3 py-1.5 text-[14px] text-fg/70 transition-colors hover:bg-fg/[0.05] hover:text-fg">
              {f.short}
            </a>
          ))}
        </nav>
      </PageHero>
      <Container className="py-12 sm:py-16">
        <Reveal>
          <DashboardShot className="mx-auto max-w-[980px]" />
        </Reveal>
      </Container>
      <div className="pb-8">
        {FEATURES.map((f, i) => {
          const Icon = f.icon;
          const visual = VISUALS[f.id];
          const flip = i % 2 === 1;
          return (
            <section key={f.id} id={f.id} className="scroll-mt-24 border-t border-border py-16 sm:py-24">
              <Container>
                <div className={cn('grid gap-10 lg:grid-cols-2 lg:gap-20', visual ? 'items-center' : 'items-start')}>
                  <Reveal className={cn(visual && flip && 'lg:order-2')}>
                    <Icon className="size-6 text-accent" strokeWidth={1.6} aria-hidden="true" />
                    <h2 className="t-h2 mt-5 text-balance">{f.title}</h2>
                    <p className="t-lead mt-4 max-w-[52ch] text-muted">{f.summary}</p>
                    {visual && <PointList points={f.points} className="mt-8" />}
                    {f.doc && (
                      <Link to={f.doc} className="mt-8 inline-flex items-center gap-1 rounded text-sm font-medium text-accent hover:underline">
                        Read the guide <ArrowRight className="size-3.5" aria-hidden="true" />
                      </Link>
                    )}
                  </Reveal>
                  <Reveal delay={0.06}>
                    {visual ? (
                      <Stage photo={visual.photo} className="aspect-[4/3] lg:aspect-[5/4]">
                        {visual.node}
                      </Stage>
                    ) : (
                      <PointList points={f.points} className="lg:mt-11" />
                    )}
                  </Reveal>
                </div>
              </Container>
            </section>
          );
        })}
      </div>
      <FinalCta />
    </>
  );
}

/** Open list with hairline dividers (no boxes). */
function PointList({ points, className }: { points: string[]; className?: string }) {
  return (
    <ul className={cn('divide-y divide-border border-y border-border', className)}>
      {points.map((p) => (
        <li key={p} className="flex items-start gap-3 py-3.5 text-[15px] leading-relaxed">
          <Check className="mt-1 size-4 shrink-0 text-accent" strokeWidth={2.2} aria-hidden="true" />
          {p}
        </li>
      ))}
    </ul>
  );
}

/* ========================================================= Integrations */

function IntegrationLogo({ i, size = 40 }: { i: Integration; size?: number }) {
  if (i.logo) return <img src={i.logo} alt="" width={size} height={size} className={cn('object-contain', i.mono && 'dark:invert')} style={{ width: size, height: size }} loading="lazy" />;
  return (
    <span className="flex items-center justify-center rounded-lg bg-fg font-semibold text-bg" style={{ width: size, height: size }} aria-hidden="true">
      {i.name[0]}
    </span>
  );
}

export function IntegrationsPage() {
  const [cat, setCat] = useState<string>('All');
  const list = cat === 'All' ? INTEGRATIONS : INTEGRATIONS.filter((i) => i.category === cat);
  return (
    <>
      <PageSeo path="/integrations" />
      <PageHero
        crumbs={[home, { label: 'Integrations' }]}
        eyebrow="Integrations"
        title="The technology behind Atlas AI."
        lead="Atlas AI calls these services from its own server; your browser never sees their keys. Listing a service describes how Atlas AI uses it. It is not a partnership or endorsement."
      />
      <Container className="py-14 sm:py-20">
        <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-2">
          {['All', ...INTEGRATION_CATEGORIES].map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={cat === c}
              onClick={() => setCat(c)}
              className={cn('rounded-full border px-3.5 py-1.5 text-sm', cat === c ? 'border-fg bg-fg text-bg' : 'border-border bg-elevated text-fg/80 hover:border-border-strong')}
            >
              {c}
            </button>
          ))}
        </div>
        <ul className="mt-12 grid gap-x-10 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((i) => (
            <li key={i.name} className="flex flex-col border-t border-border pt-7">
              <div className="flex items-start justify-between gap-3">
                <IntegrationLogo i={i} />
                <Badge tone={i.status === 'In use' ? 'accent' : 'neutral'}>{i.status}</Badge>
              </div>
              <h2 className="mt-5 text-[18px] font-semibold tracking-tight">{i.name}</h2>
              <p className="mt-1 text-sm text-muted">
                {i.category} · {i.role}
              </p>
              <ul className="mt-4 flex-1 space-y-1.5 text-[14.5px]">
                {i.usedFor.map((u) => (
                  <li key={u} className="flex gap-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                    {u}
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <a href={i.site} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded text-accent hover:underline">
                  Website <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">(opens {i.name} in a new tab)</span>
                </a>
                {i.statusPage && (
                  <a href={i.statusPage} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded text-muted hover:text-fg">
                    Status <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">(opens {i.name} status in a new tab)</span>
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-16 border-t border-border pt-8">
          <h2 className="text-[17px] font-semibold">Is there an Atlas AI API?</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
            Not yet. Atlas AI does not offer a public developer API or SDK.{' '}
            <Link to="/docs/developers" className="text-accent hover:underline">
              Read more
            </Link>
            .
          </p>
        </div>
      </Container>
    </>
  );
}

/* ================================================================ Trust */

const TRUST_TODAY: { id: string; icon: LucideIcon; title: string; items: string[] }[] = [
  {
    id: 'accounts',
    icon: UserRound,
    title: 'Account protection',
    items: [
      'Phone verification by SMS for password accounts; one number verifies only one account',
      'Email verification with single-use codes that expire after 10 minutes',
      'New accounts are reviewed before they get access',
      'Email alerts for sign-ins from a new device',
      'Device list with "remove device" and "sign out of all devices"',
      'Automatic sign-out after 60 minutes of inactivity on the web',
    ],
  },
  {
    id: 'security',
    icon: ShieldCheck,
    title: 'Application security',
    items: [
      'AI, search, email and SMS keys are kept on the server and never sent to the browser',
      'Every server request is authenticated, authorised and rate limited',
      'Firestore security rules limit each account to its own data',
      'Content Security Policy and other security headers on every page',
      'HTTPS everywhere, with HSTS',
      'Verification codes are stored only as one-way hashes',
    ],
  },
  {
    id: 'ai',
    icon: Lightbulb,
    title: 'AI safety',
    items: [
      'Free models only, enforced on the server, so no request can start paid usage',
      'Image prompts are safety-checked before any image is created',
      'Sources shown for web answers; news dates checked',
      'Notices when a different model answers or a limit is reached',
    ],
  },
  {
    id: 'privacy',
    icon: Eye,
    title: 'Privacy choices',
    items: [
      'Google Analytics only after you allow it; withdrawing removes its cookies',
      'Review, edit or delete memories; turn memory off',
      'Download your data from Settings',
      'Delete your account: disabled at once, permanently deleted after 30 days',
    ],
  },
];

const NOT_YET = [
  'No independent security audit, penetration test or certification (such as SOC 2 or ISO 27001) has been completed.',
  'There is no public, automated status monitoring yet.',
  'There is no formal bug bounty programme.',
  'Data is stored with Firebase in the United States (multi-region), not in Ghana.',
];

export function TrustPage() {
  return (
    <>
      <PageSeo path="/trust" />
      <PageHero
        crumbs={[home, { label: 'Trust' }]}
        eyebrow="Trust Centre"
        title="Security and privacy, stated plainly."
        lead="What is in place today, what is not yet, and how to report a concern. Every item below is checked against the code."
      >
        <p className="text-sm text-muted">Last updated {POLICIES_UPDATED}</p>
      </PageHero>
      <Container className="py-14 sm:py-20">
        <h2 className="t-h2">In place today</h2>
        <div className="mt-10 grid gap-x-14 gap-y-14 lg:grid-cols-2">
          {TRUST_TODAY.map(({ id, icon: Icon, title, items }) => (
            <section key={id} id={id} aria-labelledby={`${id}-t`} className="scroll-mt-24 border-t border-border pt-7">
              <div className="flex items-center gap-3">
                <Icon className="size-5 text-accent" strokeWidth={1.75} aria-hidden="true" />
                <h3 id={`${id}-t`} className="t-h3">
                  {title}
                </h3>
              </div>
              <ul className="mt-6 space-y-3">
                {items.map((t) => (
                  <li key={t} className="flex gap-3 text-[15px] leading-relaxed">
                    <CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-accent" aria-hidden="true" />
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <section className="mt-20 border-t border-border pt-7" aria-labelledby="notyet">
          <h2 id="notyet" className="t-h3 flex items-center gap-2">
            <CircleDashed className="size-5 text-muted" aria-hidden="true" /> Not in place yet
          </h2>
          <ul className="mt-5 space-y-3">
            {NOT_YET.map((t) => (
              <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-muted">
                <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-subtle" aria-hidden="true" />
                {t}
              </li>
            ))}
          </ul>
        </section>

        <section className="night mt-16 rounded-[28px] p-8 sm:p-10" aria-labelledby="report-vuln">
          <Bug className="size-6 text-accent" aria-hidden="true" />
          <h2 id="report-vuln" className="t-h3 mt-4">
            Report a security concern
          </h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
            If you believe you have found a vulnerability, email us with the details and steps to reproduce. Please do not access other people's data, run automated scans or disrupt the service.
          </p>
          <a href={`mailto:${SITE_EMAIL}?subject=${encodeURIComponent('Security report: Atlas AI')}`} className="btn btn-teal mt-6">
            <Mail className="size-4" aria-hidden="true" /> Email a security report
          </a>
        </section>

        <div className="mt-16 grid gap-x-10 gap-y-6 sm:grid-cols-3">
          {[
            { to: '/privacy', t: 'Privacy Policy', d: 'What we collect and why' },
            { to: '/docs/data-and-privacy', t: 'Data handling', d: 'Where data goes and who processes it' },
            { to: '/ai-transparency', t: 'AI Transparency', d: 'Models, routing and limits' },
          ].map((l) => (
            <Link key={l.to} to={l.to} className="group border-t border-border pt-5">
              <p className="font-medium">{l.t}</p>
              <p className="mt-1 text-sm text-muted">{l.d}</p>
              <ArrowRight className="mt-4 size-4 text-accent transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </Container>
    </>
  );
}

/* ============================================================== Contact */

const CONTACT_TOPICS: { icon: LucideIcon; title: string; text: string; subject: string }[] = [
  { icon: LifeBuoy, title: 'Support', text: 'Problems with your account or the app.', subject: 'Support: ' },
  { icon: MessageSquare, title: 'Feedback & ideas', text: 'Feature requests and suggestions.', subject: 'Feedback: ' },
  { icon: ShieldCheck, title: 'Privacy requests', text: 'Access, correction or deletion of your data.', subject: 'Privacy request: ' },
  { icon: Bug, title: 'Security', text: 'Report a suspected vulnerability.', subject: 'Security report: ' },
  { icon: AccessibilityIcon, title: 'Accessibility', text: 'Tell us about a barrier you met.', subject: 'Accessibility: ' },
  { icon: Handshake, title: 'Partnerships & press', text: 'Business and media enquiries.', subject: 'Partnership: ' },
];

export function ContactPage() {
  const { access } = useAuth();
  const signedIn = access === 'allowed';
  return (
    <>
      <PageSeo path="/contact" />
      <PageHero crumbs={[home, { label: 'Contact' }]} eyebrow="Contact" title="Get in touch." lead="Choose a topic to open an email with the subject filled in. Please never include passwords or verification codes." />
      <Container className="py-14 sm:py-20">
        {signedIn && (
          <div className="mb-10 flex flex-col justify-between gap-4 rounded-[22px] border border-accent/25 bg-accent-soft p-6 sm:flex-row sm:items-center">
            <div>
              <p className="font-medium">You are signed in</p>
              <p className="mt-1 text-sm text-muted">Report an issue in the app to get a reference number and replies in your notifications.</p>
            </div>
            <Link to="/support/new" className="btn btn-dark btn-sm">
              Report an issue
            </Link>
          </div>
        )}
        <ul className="grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {CONTACT_TOPICS.map(({ icon: Icon, title, text, subject }) => (
            <li key={title}>
              <a href={`mailto:${SITE_EMAIL}?subject=${encodeURIComponent(`${subject}Atlas AI`)}`} className="group flex h-full flex-col border-t border-border pt-6">
                <Icon className="size-5 text-accent" aria-hidden="true" />
                <span className="mt-4 text-[17px] font-semibold tracking-tight">{title}</span>
                <span className="mt-1.5 flex-1 text-[14.5px] text-muted">{text}</span>
                <span className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-accent">
                  Email us <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
              </a>
            </li>
          ))}
        </ul>
        <div className="mt-16 grid gap-8 border-t border-border pt-8 sm:grid-cols-2">
          <div>
            <p className="t-eyebrow text-subtle">Email</p>
            <a href={`mailto:${SITE_EMAIL}`} className="mt-2 inline-block text-[17px] font-medium break-all text-fg hover:text-accent">
              {SITE_EMAIL}
            </a>
          </div>
          <div>
            <p className="t-eyebrow text-subtle">Before you write</p>
            <p className="mt-2 text-[15px] text-muted">
              Many answers are in the{' '}
              <Link to="/help-centre" className="text-accent hover:underline">
                Help Centre
              </Link>{' '}
              and the{' '}
              <Link to="/docs" className="text-accent hover:underline">
                documentation
              </Link>
              .
            </p>
          </div>
        </div>
      </Container>
    </>
  );
}

/* =============================================================== Status */

export function StatusPage() {
  const deps = INTEGRATIONS.filter((i) => i.statusPage);
  return (
    <>
      <PageSeo path="/status" />
      <PageHero crumbs={[home, { label: 'Status' }]} eyebrow="Status" title="Service status." lead="Atlas AI does not have automated public status monitoring yet, so this page does not show a live status or uptime figure." />
      <Container className="py-14 sm:py-20">
        <div className="flex gap-4 rounded-[22px] border border-amber-300/60 bg-amber-50 p-6 text-amber-950 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">Having trouble right now?</p>
            <p className="mt-1 text-[15px] leading-relaxed">
              Check the provider status pages below. If they are all working, please tell us: signed-in users can use <b>Settings → Report an issue</b>, or{' '}
              <Link to="/contact" className="underline">
                contact us
              </Link>
              .
            </p>
          </div>
        </div>
        <h2 className="t-h3 mt-14">Services Atlas AI depends on</h2>
        <ul className="mt-6 divide-y divide-border border-y border-border">
          {deps.map((i) => (
            <li key={i.name} className="flex flex-wrap items-center gap-4 py-4">
              <IntegrationLogo i={i} size={28} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{i.name}</p>
                <p className="text-sm text-muted">{i.role}</p>
              </div>
              <a href={i.statusPage} target="_blank" rel="noopener noreferrer" className="btn btn-light btn-sm">
                Status page <ArrowUpRight className="size-3.5" aria-hidden="true" />
                <span className="sr-only">for {i.name} (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-sm text-muted">Tavily and Vynfy do not publish a public status page that we can link to.</p>
      </Container>
    </>
  );
}

/* ============================================================== Pricing */

export function PricingPage() {
  return (
    <>
      <PageSeo path="/pricing" />
      <PageHero crumbs={[home, { label: 'Pricing' }]} eyebrow="Pricing" title="Pricing has not been published yet." lead="Atlas AI currently uses free AI models only, enforced on the server. If paid plans are introduced, they will be announced here and in the changelog before anything changes." />
      <Container className="py-14 sm:py-20">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link to={APP_LINKS.register} className="btn btn-dark btn-lg">
            Start using Atlas AI
          </Link>
          <Link to="/contact" className="btn btn-light btn-lg">
            Ask a question
          </Link>
        </div>
      </Container>
    </>
  );
}

/* ============================================================ Changelog */

const TAG_TONE: Record<string, string> = {
  New: 'bg-accent-soft text-accent',
  Improved: 'bg-cyan-50 text-cyan-800',
  Fixed: 'bg-surface-2 text-muted',
  Security: 'bg-amber-50 text-amber-900',
};

export function ChangelogPage() {
  return (
    <>
      <PageSeo path="/changelog" />
      <PageHero crumbs={[home, { label: 'Changelog' }]} eyebrow="Changelog" title="What’s new in Atlas AI." lead="Every release, newest first, with the date it shipped." />
      <Container className="py-14 sm:py-20" narrow>
        <ol className="relative border-l border-border pl-6 sm:pl-10">
          {RELEASES.map((r, i) => (
            <li key={`${r.date}-${i}`} className="relative pb-12 last:pb-0">
              <span className="absolute top-1.5 -left-[29px] size-2.5 rounded-full border-2 border-bg bg-accent ring-4 ring-accent-soft sm:-left-[45px]" aria-hidden="true" />
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <time dateTime={r.date}>{fmtDate(r.date)}</time>
                {r.version && <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-xs">v{r.version}</span>}
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TAG_TONE[r.tag])}>{r.tag}</span>
              </div>
              <h2 className="mt-2 text-[20px] font-semibold tracking-tight">{r.title}</h2>
              <ul className="mt-3 space-y-1.5 text-[15px] leading-relaxed text-fg/85">
                {r.items.map((t) => (
                  <li key={t} className="flex gap-2.5">
                    <span className="mt-2.5 size-1 shrink-0 rounded-full bg-subtle" aria-hidden="true" />
                    {t}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Container>
    </>
  );
}

/* ========================================================== Help Centre */

const TOPIC_ICONS: Record<string, LucideIcon> = { UserRound, MessageSquare, Globe, FileText, ShieldCheck };

export function HelpCentrePage() {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return null;
    const faqs = HELP_TOPICS.flatMap((tp) => tp.faqs).filter((f) => `${f.q} ${f.a}`.toLowerCase().includes(t));
    return { faqs, docs: searchDocs(q).slice(0, 6) };
  }, [q]);
  return (
    <>
      <PageSeo path="/help-centre" />
      <PageHero crumbs={[home, { label: 'Help Centre' }]} eyebrow="Help Centre" title="How can we help?" lead="Quick answers, with links to the full guides.">
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search, e.g. “reset password” or “PDF”"
            aria-label="Search help"
            className="h-13 w-full rounded-2xl border border-border-strong bg-elevated pr-4 pl-11 text-[15px] shadow-[0_8px_24px_-16px_rgba(7,19,18,0.35)] outline-none focus:border-accent"
          />
        </div>
      </PageHero>
      <Container className="py-14 sm:py-20">
        {results ? (
          <div aria-live="polite">
            <h2 className="t-h3">
              {results.faqs.length + results.docs.length} result{results.faqs.length + results.docs.length === 1 ? '' : 's'}
            </h2>
            {results.faqs.length > 0 && (
              <div className="mt-6 border-t border-border">
                {results.faqs.map((f) => (
                  <FaqItem key={f.q} q={f.q} a={f.a} doc={f.doc} open />
                ))}
              </div>
            )}
            {results.docs.length > 0 && (
              <ul className="mt-6 grid gap-3 sm:grid-cols-2">
                {results.docs.map((d) => (
                  <li key={d.slug}>
                    <Link to={`/docs/${d.slug}`} className="block border-t border-border pt-4 hover:text-accent">
                      <p className="font-medium">{d.title}</p>
                      <p className="mt-1 text-sm text-muted">{d.summary}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {results.faqs.length + results.docs.length === 0 && (
              <p className="mt-4 text-muted">
                Nothing found. Try other words, or{' '}
                <Link to="/contact" className="text-accent hover:underline">
                  contact us
                </Link>
                .
              </p>
            )}
          </div>
        ) : (
          <div className="grid gap-12">
            {HELP_TOPICS.map((t) => {
              const Icon = TOPIC_ICONS[t.icon] ?? Compass;
              return (
                <section key={t.title} aria-labelledby={`h-${t.icon}`} className="grid gap-6 lg:grid-cols-[280px_1fr] lg:gap-12">
                  <div>
                    <Icon className="size-5 text-accent" aria-hidden="true" />
                    <h2 id={`h-${t.icon}`} className="t-h3 mt-3">
                      {t.title}
                    </h2>
                    <p className="mt-1 text-sm text-muted">{t.description}</p>
                  </div>
                  <div className="border-t border-border">
                    {t.faqs.map((f) => (
                      <FaqItem key={f.q} {...f} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        <div className="mt-16 flex flex-col items-start justify-between gap-4 border-t border-border pt-8 sm:flex-row sm:items-center">
          <div>
            <p className="font-medium">Still need help?</p>
            <p className="mt-1 text-sm text-muted">Browse the full documentation or get in touch.</p>
          </div>
          <div className="flex gap-2">
            <Link to="/docs" className="btn btn-light btn-sm">
              Documentation
            </Link>
            <Link to="/contact" className="btn btn-dark btn-sm">
              Contact
            </Link>
          </div>
        </div>
      </Container>
    </>
  );
}

function FaqItem({ q, a, doc, open }: { q: string; a: string; doc?: string; open?: boolean }) {
  return (
    <details open={open} className="group border-b border-border py-4 open:pb-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15.5px] font-medium [&::-webkit-details-marker]:hidden">
        {q}
        <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">{a}</p>
      {doc && (
        <Link to={doc} className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-accent hover:underline">
          Read more <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      )}
    </details>
  );
}

/* ============================================================= Policies */

export function PolicyPage({ slug }: { slug: Policy['slug'] }) {
  const p = POLICIES[slug];
  const m = meta(`/${slug}`);
  return (
    <>
      <Seo title={m.title} description={m.description} path={m.path} />
      <PageHero crumbs={[home, { label: m.crumb ?? p.title }]} eyebrow="Policy" title={p.title} lead={p.intro}>
        <p className="text-sm text-muted">Last updated {p.updated}</p>
      </PageHero>
      <Container className="py-14 sm:py-20" narrow>
        <SiteMarkdown content={p.body} />
        <p className="mt-14 border-t border-border pt-6 text-sm text-muted">
          See also{' '}
          <Link to="/privacy" className="text-accent hover:underline">
            Privacy Policy
          </Link>{' '}
          ·{' '}
          <Link to="/terms" className="text-accent hover:underline">
            Terms of Use
          </Link>{' '}
          ·{' '}
          <Link to="/trust" className="text-accent hover:underline">
            Trust Centre
          </Link>
        </p>
      </Container>
    </>
  );
}

/* ============================================================ Not found */

export function NotFoundPage() {
  return (
    <>
      <Seo title="Page not found" description="The page you were looking for does not exist." path="/404" noindex />
      <section className="relative overflow-hidden">
        <Container className="relative flex min-h-[60vh] flex-col items-center justify-center py-24 text-center">
          <p className="font-mono text-sm text-accent">404</p>
          <h1 className="t-h1 mt-4">This page took a different route.</h1>
          <p className="t-lead mt-4 max-w-md text-muted">The page you were looking for does not exist or has moved.</p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link to="/" className="btn btn-dark">
              Go to the home page
            </Link>
            <Link to="/docs" className="btn btn-light">
              Browse the docs
            </Link>
          </div>
        </Container>
      </section>
    </>
  );
}

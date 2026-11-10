import { motion, useInView, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Bell,
  BookOpen,
  Brain,
  Briefcase,
  Code2,
  FileText,
  FlaskConical,
  Fingerprint,
  GraduationCap,
  Layers,
  Lightbulb,
  ListChecks,
  Lock,
  MessageSquare,
  Palette,
  PenLine,
  Rocket,
  ScanSearch,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserCheck,
  Users,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { INTEGRATIONS } from '../content/integrations';
import { APP_LINKS, PAGES } from '../content/site';
import { Seo } from '../layout/Seo';
import { Container, Eyebrow, Reveal, SectionHeading } from '../layout/ui';
import { DashboardShot } from './DashboardShot';
import { FloatCard, FloatCluster } from './Float';
import { InAction } from './InAction';
import {
  ComposerMock,
  DocumentCard,
  ImageCard,
  PhoneMock,
  ResearchCard,
  SourcesButton,
  TypedComposer,
  VoiceOrb,
} from './Previews';

const HOME = PAGES[0];

/* ------------------------------------------------------------------ Hero */

function Headline() {
  const reduce = useReducedMotion();
  const words = ['Think', 'Further.', 'Do', 'More.'];
  return (
    <h1 className="t-display text-balance text-fg">
      {words.map((w, i) => (
        <motion.span
          key={w}
          className={cn('inline-block', i >= 2 && 'text-gradient')}
          initial={reduce ? false : { opacity: 0, y: 28, filter: 'blur(8px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.8, delay: 0.08 + i * 0.09, ease: [0.2, 0.7, 0.2, 1] }}
        >
          {w}
          {i < words.length - 1 && ' '}
        </motion.span>
      ))}
    </h1>
  );
}

function Hero() {
  const reduce = useReducedMotion();
  const rise = (d: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.7, delay: d, ease: [0.2, 0.7, 0.2, 1] as const },
        };
  return (
    <section className="relative overflow-hidden">
      <Container className="relative pt-14 sm:pt-20 lg:pt-24">
        <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center text-center">
          <motion.div {...rise(0)}>
            <Link
              to="/changelog"
              className="group inline-flex items-center gap-2 rounded-full border border-border bg-elevated/80 py-1 pr-3 pl-1 text-[13px] text-muted backdrop-blur hover:border-border-strong hover:text-fg"
            >
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-white">
                New
              </span>
              Voice Mode and natural voices
              <ArrowRight
                className="size-3.5 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
          </motion.div>
          <div className="mt-7">
            <Headline />
          </div>
          <motion.p
            {...rise(0.35)}
            className="mt-6 max-w-2xl text-[clamp(1.2rem,1.05rem+0.6vw,1.5rem)] leading-snug font-medium tracking-tight text-balance text-fg"
          >
            One intelligent workspace for research, creativity, productivity and problem-solving.
          </motion.p>
          <motion.p {...rise(0.45)} className="t-lead mt-3 max-w-xl text-balance text-muted">
            Explore ideas, understand information, create content, write code and get more done with
            Atlas AI.
          </motion.p>
          <motion.div {...rise(0.55)} className="mt-9 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
            <Link to={APP_LINKS.register} className="btn btn-dark btn-lg">
              Start using Atlas AI <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <a
              href="#explore"
              className="btn btn-light btn-lg"
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById('explore')
                  ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
              }}
            >
              Explore Atlas AI
            </a>
          </motion.div>
        </div>

        {/* Product presentation on a soft, blurred landscape */}
        <div className="relative mt-16 sm:mt-20">
          <motion.div
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.4, delay: 0.2 }}
            className="pointer-events-none absolute -inset-x-2 -top-16 bottom-0 overflow-hidden rounded-[28px] sm:-inset-x-4 sm:-top-28 sm:rounded-[40px]"
            aria-hidden="true"
          >
            <img
              src="/photos/hero-backdrop-1600.webp"
              srcSet="/photos/hero-backdrop-800.webp 800w, /photos/hero-backdrop-1600.webp 1600w"
              sizes="100vw"
              alt=""
              width={1600}
              height={667}
              decoding="async"
              className="hero-backdrop size-full scale-110 object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-bg via-bg/30 to-bg/0 dark:via-bg/50 dark:to-bg/25" />
          </motion.div>
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 60 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
            className="relative mx-auto max-w-[1040px] px-2 pb-12 sm:px-6 sm:pb-16"
          >
            {/* A real screenshot of the Atlas AI dashboard (light and dark) */}
            <DashboardShot priority />
            <div className="float-a absolute top-28 -left-14 hidden xl:block" aria-hidden="true">
              <ResearchCard />
            </div>
            <div className="float-b absolute -right-16 bottom-28 hidden xl:block" aria-hidden="true">
              <DocumentCard />
            </div>
            <div className="float-b absolute -top-8 right-10 hidden lg:block" aria-hidden="true">
              <div className="shadow-panel flex items-center gap-2 rounded-full border border-border bg-elevated px-3 py-2 text-[12.5px] text-fg">
                <span className="relative flex size-2">
                  <span className="pulse-ring absolute inset-0 rounded-full bg-accent" />
                  <span className="relative size-2 rounded-full bg-accent" />
                </span>
                Searching the web…
              </div>
            </div>
          </motion.div>
        </div>
      </Container>
      <div className="h-16 sm:h-24" />
    </section>
  );
}

/* --------------------------------------------------------------- Marquee */

const MARQUEE = INTEGRATIONS.filter((i) => i.logo && i.category !== 'Analytics');

function IntegrationMarquee() {
  const row = (hidden: boolean) =>
    MARQUEE.map((i) => (
      <li
        key={`${i.name}-${hidden}`}
        aria-hidden={hidden || undefined}
        className="flex shrink-0 items-center gap-3 px-7 sm:px-10"
      >
        <img
          src={i.logo!}
          alt={hidden ? '' : `${i.name} logo`}
          width={30}
          height={30}
          loading="lazy"
          decoding="async"
          className={cn('size-[30px] object-contain', i.mono && 'dark:invert')}
        />
        <span className="text-[17px] font-medium tracking-tight whitespace-nowrap text-fg/80">
          {i.name}
        </span>
      </li>
    ));
  return (
    <section
      aria-labelledby="ecosystem"
      className="border-y border-border bg-elevated/50 py-12 sm:py-14"
    >
      <Container>
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 id="ecosystem" className="text-[15px] font-medium text-fg">
            Powered by a growing ecosystem of technology.
          </h2>
          <p className="text-[13px] text-muted">
            Services Atlas AI uses today. Their use does not imply a partnership or endorsement.
          </p>
        </div>
      </Container>
      <div className="marquee mt-9 overflow-hidden">
        <ul className="marquee-track">
          {row(false)}
          {row(true)}
        </ul>
      </div>
      <p className="mt-8 text-center">
        <Link
          to="/integrations"
          className="inline-flex items-center gap-1 rounded text-sm font-medium text-accent hover:underline"
        >
          How each service is used <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </p>
    </section>
  );
}

/* ----------------------------------------------------- Product intro */

const CAPS: { icon: LucideIcon; label: string }[] = [
  { icon: MessageSquare, label: 'Chat' },
  { icon: Search, label: 'Web search' },
  { icon: FlaskConical, label: 'Deep Research' },
  { icon: FileText, label: 'Documents' },
  { icon: ScanSearch, label: 'Image understanding' },
  { icon: Wand2, label: 'Image creation' },
  { icon: Sparkles, label: 'Voice Mode' },
  { icon: Brain, label: 'Memory' },
];

function ProductIntro() {
  return (
    <section id="explore" className="scroll-mt-20 py-24 sm:py-32">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.05fr] lg:gap-20">
          <Reveal>
            <SectionHeading
              eyebrow="One workspace"
              title={
                <>
                  Everything you reach for, <span className="text-muted">in one place.</span>
                </>
              }
              lead="Most work jumps between a chatbot, a search engine, a PDF reader, a translator and an image tool. Atlas AI brings them into one conversation, so context carries from one step to the next."
            />
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
              {CAPS.map(({ icon: Icon, label }) => (
                <li
                  key={label}
                  className="inline-flex items-center gap-1.5 py-1 text-[14.5px] text-fg/85"
                >
                  <Icon className="size-3.5 text-accent" aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
            <Link to="/features" className="btn btn-light mt-9">
              See every feature <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Reveal>
          <Reveal delay={0.1}>
            <FloatCluster width={580} height={540}>
              <div className="absolute inset-[12%] rounded-full bg-accent/15 blur-3xl" />
              <FloatCard
                style={{ top: 0, left: 0 }}
                rotate={-4}
                depth={12}
                drift={8}
                from={{ x: -40, y: 30 }}
              >
                <ImageCard className="w-[300px]" />
              </FloatCard>
              <FloatCard
                style={{ top: 96, right: 0 }}
                rotate={3}
                depth={22}
                delay={0.15}
                drift={7}
                from={{ x: 40, y: 30 }}
              >
                <DocumentCard className="w-[270px]" />
              </FloatCard>
              <FloatCard
                style={{ bottom: 0, left: 80 }}
                rotate={-1.5}
                depth={30}
                delay={0.3}
                drift={9}
                from={{ x: 0, y: 50 }}
              >
                <ResearchCard className="w-[280px]" />
              </FloatCard>
            </FloatCluster>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------- Feature showcase */

function ResearchShowcase() {
  return (
    <section className="py-20 sm:py-28" aria-labelledby="research-title">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
          <Reveal className="lg:order-2">
            <Eyebrow>Live web search · Deep Research</Eyebrow>
            <h2 id="research-title" className="t-h2 mt-4 text-balance">
              Answers that show their work.
            </h2>
            <p className="t-lead mt-4 text-muted">
              When a question needs current information, Atlas searches the web through Tavily and
              SerpAPI and shows every source behind the answer. For bigger questions, Deep Research
              plans several searches, reads the most relevant pages and writes a structured report.
            </p>
            <dl className="mt-8 grid gap-5 sm:grid-cols-2">
              {[
                [
                  'Search when it matters',
                  'Greetings and everyday questions are answered directly; news, prices and recent events are searched.',
                ],
                [
                  'Sources you can open',
                  'Numbered citations and a Sources button with every site and date.',
                ],
                [
                  'Dates checked',
                  'News dates are confirmed against the feed, provider and page address.',
                ],
                [
                  'Honest limits',
                  'When a search limit is reached, Atlas tells you instead of guessing.',
                ],
              ].map(([t, d]) => (
                <div key={t} className="border-l-2 border-accent/30 pl-4">
                  <dt className="text-[15px] font-medium text-fg">{t}</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-muted">{d}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
          <Reveal delay={0.08} className="lg:order-1">
            <div className="relative sm:pr-8 sm:pb-8" aria-hidden="true">
              <div className="shadow-panel rounded-2xl border border-[#e3dfd4] bg-white p-5 text-[#1a1a1c]">
                <div className="flex justify-end">
                  <p className="max-w-[85%] rounded-[20px] rounded-br-md bg-[#efefed] px-3.5 py-2 text-[13px]">
                    Compare solar inverter options for a small office in Accra.
                  </p>
                </div>
                <div className="mt-4 text-[13px] leading-relaxed">
                  <p className="font-semibold">Summary</p>
                  <p className="mt-1 text-[#3a3a3f]">
                    Hybrid inverters suit most small offices with frequent outages{' '}
                    <sup className="text-[#0f766e]">[1]</sup>. Size for peak load plus 25% headroom{' '}
                    <sup className="text-[#0f766e]">[2]</sup>, and check local installer support{' '}
                    <sup className="text-[#0f766e]">[3]</sup>.
                  </p>
                  <div className="mt-3 overflow-hidden rounded-lg border border-[#ecebe6] text-[11.5px]">
                    <div className="grid grid-cols-3 bg-[#f7f7f6] px-3 py-1.5 font-medium">
                      <span>Type</span>
                      <span>Best for</span>
                      <span>Backup</span>
                    </div>
                    {[
                      ['Hybrid', 'Outages', 'Yes'],
                      ['Grid-tie', 'Lowest cost', 'No'],
                      ['Off-grid', 'No grid', 'Yes'],
                    ].map((r) => (
                      <div
                        key={r[0]}
                        className="grid grid-cols-3 border-t border-[#ecebe6] px-3 py-1.5"
                      >
                        {r.map((c) => (
                          <span key={c}>{c}</span>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3">
                    <SourcesButton />
                  </div>
                </div>
              </div>
              <div className="absolute -right-3 -bottom-8 max-sm:hidden">
                <ResearchCard />
              </div>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

function VoiceBand() {
  return (
    <section
      className="night relative overflow-hidden py-24 sm:py-32"
      aria-labelledby="voice-title"
    >
      <Container className="relative">
        <div className="grid items-center gap-14 lg:grid-cols-[1.1fr_1fr]">
          <Reveal>
            <Eyebrow>Voice Mode</Eyebrow>
            <h2 id="voice-title" className="t-h2 mt-4 text-balance">
              Talk it through. <span className="text-gradient">Hands-free.</span>
            </h2>
            <p className="t-lead mt-4 max-w-xl text-muted">
              Voice Mode is a continuous spoken conversation. Atlas listens, answers aloud while it
              is still writing, and stops when you start talking. Every word is saved in the
              conversation, so you can switch back to text at any time.
            </p>
            <ul className="mt-8 grid gap-3 sm:grid-cols-2">
              {[
                'Speech to text with Whisper',
                'Replies spoken sentence by sentence',
                'Interrupt just by talking',
                'Natural voices, with ElevenLabs as an option',
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-[15px] text-fg/90">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                  {t}
                </li>
              ))}
            </ul>
            <Link to="/docs/voice-mode" className="btn btn-ghost-night mt-9">
              How Voice Mode works <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Reveal>
          <Reveal delay={0.1}>
            <div
              className="relative mx-auto flex max-w-md flex-col items-center rounded-[32px] border border-white/10 bg-white/[0.03] px-6 py-12 backdrop-blur"
              aria-hidden="true"
            >
              <VoiceOrb className="text-[#cfe9e4]" />
              <div className="mt-8 w-full space-y-3 text-[13.5px]">
                <p className="ml-auto w-fit max-w-[85%] rounded-[18px] rounded-br-md bg-white/10 px-3.5 py-2">
                  What should I pack for three days in Kumasi?
                </p>
                <p className="max-w-[90%] text-[#cfe9e4]">
                  Light cotton clothes, an umbrella for afternoon showers, comfortable walking shoes
                  and…
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

function Bento() {
  const cell = 'relative border-t border-border pt-7';
  return (
    <section className="py-20 sm:py-28" aria-labelledby="bento-title">
      <Container>
        <Reveal>
          <SectionHeading
            eyebrow="Capabilities"
            title={<span id="bento-title">Built for the work you actually do.</span>}
            lead="Write, code, study, plan and create. Every capability below is live in Atlas AI today."
          />
        </Reveal>
        <div className="mt-14 grid gap-x-10 gap-y-14 md:grid-cols-6">
          <Reveal className="md:col-span-4">
            <div className={cn(cell, 'h-full')}>
              <FileText className="size-5 text-accent" aria-hidden="true" />
              <h3 className="t-h3 mt-4">Document intelligence</h3>
              <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted">
                Ask questions about PDFs, Word files, spreadsheets and slide decks up to 25 MB.
                Atlas finds the relevant sections and tells you how much of the document it read.
              </p>
              <div className="mt-6 flex flex-wrap gap-2" aria-hidden="true">
                {['PDF', 'DOCX', 'XLSX', 'CSV', 'PPTX', 'TXT', 'MD', 'JSON', 'HTML'].map((f) => (
                  <span
                    key={f}
                    className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-muted"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>
          <Reveal className="md:col-span-2" delay={0.05}>
            <div className={cn(cell, 'h-full')}>
              <Wand2 className="size-5 text-accent" aria-hidden="true" />
              <h3 className="t-h3 mt-4">Image creation</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">
                Describe a picture, or attach one and describe the change. Every prompt is
                safety-checked first.
              </p>
              <div className="mt-5 flex justify-center" aria-hidden="true">
                <ImageCard className="w-[170px] rotate-2" />
              </div>
            </div>
          </Reveal>
          <Reveal className="md:col-span-2">
            <div className={cn(cell, 'h-full')}>
              <Code2 className="size-5 text-accent" aria-hidden="true" />
              <h3 className="t-h3 mt-4">Programming help</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">
                Explain an error, review a function or sketch a script, with highlighted code and
                one-tap copy.
              </p>
              <pre
                className="mt-5 overflow-hidden rounded-xl bg-[#0b1413] p-3 font-mono text-[11.5px] leading-relaxed text-[#cfe9e4]"
                aria-hidden="true"
              >
                <span className="text-[#5eead4]">def</span>{' '}
                <span className="text-[#a5f3fc]">total</span>(items):{'\n'}
                {'    '}
                <span className="text-[#5eead4]">return</span> sum(i.price{' '}
                <span className="text-[#5eead4]">for</span> i{' '}
                <span className="text-[#5eead4]">in</span> items)
              </pre>
            </div>
          </Reveal>
          <Reveal className="md:col-span-2" delay={0.05}>
            <div className={cn(cell, 'h-full')}>
              <PenLine className="size-5 text-accent" aria-hidden="true" />
              <h3 className="t-h3 mt-4">Writing and documents</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">
                Draft emails, reports, essays and plans; then refine the tone, shorten or translate
                them in the same thread.
              </p>
            </div>
          </Reveal>
          <Reveal className="md:col-span-2" delay={0.1}>
            <div className={cn(cell, 'h-full')}>
              <Layers className="size-5 text-accent" aria-hidden="true" />
              <h3 className="t-h3 mt-4">Multi-model routing</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">
                Google Gemini first, with free models through OpenRouter. If a model cannot handle a
                request, a capable one steps in and Atlas tells you.
              </p>
            </div>
          </Reveal>
          <Reveal className="md:col-span-3">
            <div className={cn(cell, 'flex h-full flex-col sm:flex-row sm:items-center sm:gap-6')}>
              <div className="flex-1">
                <Smartphone className="size-5 text-accent" aria-hidden="true" />
                <h3 className="t-h3 mt-4">On every screen</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">
                  Install Atlas AI on your phone or computer. It opens in its own window and updates
                  itself.
                </p>
              </div>
              <div className="mt-6 flex justify-center sm:mt-0" aria-hidden="true">
                <PhoneMock className="w-[190px] origin-top scale-90" />
              </div>
            </div>
          </Reveal>
          <Reveal className="md:col-span-3" delay={0.05}>
            <div className={cn(cell, 'h-full')}>
              <Brain className="size-5 text-accent" aria-hidden="true" />
              <h3 className="t-h3 mt-4">Memory, projects and knowledge</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">
                Atlas remembers the preferences you allow, groups related chats into projects with
                shared instructions, and draws on documents you saved to your knowledge base.
              </p>
              <ul className="mt-5 divide-y divide-border border-y border-border" aria-hidden="true">
                {[
                  'Prefers British English',
                  'Studying for the WASSCE in May',
                  'Works in Python and SQL',
                ].map((m) => (
                  <li key={m} className="flex items-center justify-between py-2.5 text-[13.5px]">
                    {m} <span className="text-[11px] text-subtle">Memory</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------- Use cases */

const USE_CASES: {
  id: string;
  label: string;
  icon: LucideIcon;
  intro: string;
  prompts: string[];
  uses: string[];
}[] = [
  {
    id: 'students',
    label: 'Students',
    icon: GraduationCap,
    intro: 'Understand difficult topics, revise faster and check your reasoning.',
    prompts: [
      'Explain photosynthesis like I’m revising for an exam, then quiz me',
      'Summarise chapter 4 of this PDF into revision notes',
      'Where is the mistake in my working for this equation?',
    ],
    uses: ['Documents', 'Memory', 'Voice'],
  },
  {
    id: 'researchers',
    label: 'Researchers',
    icon: FlaskConical,
    intro: 'Survey a topic quickly and keep every claim traceable to a source.',
    prompts: [
      'Deep Research: recent studies on malaria vaccine rollout in West Africa',
      'Compare the methods sections of these two papers',
      'List the open questions this review identifies',
    ],
    uses: ['Deep Research', 'Sources', 'Documents'],
  },
  {
    id: 'developers',
    label: 'Developers',
    icon: Code2,
    intro: 'Debug, refactor and learn new tools without leaving the conversation.',
    prompts: [
      'Why does this React effect run twice?',
      'Rewrite this function to be easier to test',
      'Search the docs: what changed in the latest Node.js release?',
    ],
    uses: ['Code blocks', 'Web search', 'Projects'],
  },
  {
    id: 'business',
    label: 'Professionals',
    icon: Briefcase,
    intro: 'Turn reports and spreadsheets into decisions and clear writing.',
    prompts: [
      'What are the three biggest risks in this annual report?',
      'Total sales by region from this spreadsheet and explain the trend',
      'Draft a polite follow-up email to a client',
    ],
    uses: ['Documents', 'Spreadsheets', 'Writing'],
  },
  {
    id: 'entrepreneurs',
    label: 'Entrepreneurs',
    icon: Rocket,
    intro: 'Validate ideas, research markets and plan the next step.',
    prompts: [
      'Research competitors for a food delivery app in Kumasi',
      'Write a one-page business plan outline',
      'Create a logo concept image for a juice brand',
    ],
    uses: ['Deep Research', 'Image creation', 'Writing'],
  },
  {
    id: 'creators',
    label: 'Creators',
    icon: Palette,
    intro: 'Go from a spark to a script, caption or illustration.',
    prompts: [
      'Ten video ideas about budget travel in Ghana',
      'Turn this outline into a 60-second script',
      'Create a thumbnail image of a sunrise over Lake Volta',
    ],
    uses: ['Image creation', 'Writing', 'Translation'],
  },
  {
    id: 'educators',
    label: 'Educators',
    icon: BookOpen,
    intro: 'Prepare lessons, examples and assessments in less time.',
    prompts: [
      'Create a lesson plan on fractions for 10-year-olds',
      'Write five multiple-choice questions from this handout',
      'Translate this notice into French, keeping the layout',
    ],
    uses: ['Documents', 'Translation', 'Projects'],
  },
  {
    id: 'everyone',
    label: 'Everyday',
    icon: Users,
    intro: 'Plan, compare and get answers in plain language.',
    prompts: [
      'What’s the news this morning?',
      'Plan a week of cheap, healthy dinners',
      'Talk me through setting up two-factor sign-in',
    ],
    uses: ['News', 'Voice Mode', 'Chat'],
  },
];

function UseCases() {
  const [active, setActive] = useState(USE_CASES[0].id);
  const current = USE_CASES.find((u) => u.id === active) ?? USE_CASES[0];
  const reduce = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inView = useInView(sectionRef, { amount: 0.35 });
  const [hold, setHold] = useState(false); // pointer over or focus inside
  const [paused, setPaused] = useState(0); // bumps on each manual pick, 0 = not paused
  const auto = inView && !hold && !reduce && !paused;

  const pick = (id: string, manual: boolean) => {
    setActive(id);
    if (manual) setPaused((n) => n + 1);
    const list = listRef.current;
    const tab = document.getElementById(`uc-tab-${id}`);
    if (list && tab)
      list.scrollTo({
        left: tab.offsetLeft - list.clientWidth / 2 + tab.clientWidth / 2,
        behavior: reduce ? 'auto' : 'smooth',
      });
  };

  // A manual pick pauses the rotation for 8s.
  useEffect(() => {
    if (!paused) return;
    const t = window.setTimeout(() => setPaused(0), 8000);
    return () => window.clearTimeout(t);
  }, [paused]);

  // Every 3s, move to the next tab while the section is on screen.
  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => {
      const idx = USE_CASES.findIndex((u) => u.id === active);
      pick(USE_CASES[(idx + 1) % USE_CASES.length].id, false);
    }, 3000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, active]);

  const onKey = (e: KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next =
      USE_CASES[(idx + (e.key === 'ArrowRight' ? 1 : USE_CASES.length - 1)) % USE_CASES.length];
    pick(next.id, true);
    document.getElementById(`uc-tab-${next.id}`)?.focus();
  };
  return (
    <section
      ref={sectionRef}
      className="border-y border-border bg-surface/70 py-20 sm:py-28"
      aria-labelledby="uc-title"
    >
      <Container>
        <Reveal>
          <SectionHeading
            eyebrow="Use cases"
            title={<span id="uc-title">Made for how different people think.</span>}
            lead="Example requests for different kinds of work. Try any of them once you are signed in."
          />
        </Reveal>
        <div
          className="mt-12"
          onPointerEnter={() => setHold(true)}
          onPointerLeave={() => setHold(false)}
          onFocus={() => setHold(true)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setHold(false)}
        >
          <div
            ref={listRef}
            role="tablist"
            aria-label="Who uses Atlas AI"
            className="scroll-thin relative -mx-4 flex gap-2 overflow-x-auto px-4 pb-2"
          >
            {USE_CASES.map((u, i) => {
              const Icon = u.icon;
              const on = u.id === active;
              return (
                <button
                  key={u.id}
                  id={`uc-tab-${u.id}`}
                  role="tab"
                  type="button"
                  aria-selected={on}
                  aria-controls="uc-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => pick(u.id, true)}
                  onKeyDown={(e) => onKey(e, i)}
                  className={cn(
                    'relative inline-flex shrink-0 items-center gap-2 overflow-hidden rounded-full border px-4 py-2 text-sm transition-colors duration-300',
                    on
                      ? 'border-fg bg-fg text-bg'
                      : 'border-border bg-elevated text-fg/80 hover:border-border-strong hover:text-fg',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {u.label}
                  {on && auto && (
                    <span
                      className="uc-progress pointer-events-none absolute inset-x-0 bottom-0 h-[2px] origin-left bg-accent"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
          <motion.div
            key={current.id}
            id="uc-panel"
            role="tabpanel"
            aria-labelledby={`uc-tab-${current.id}`}
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="mt-10 grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14"
          >
            <div>
              <h3 className="t-h3">{current.label}</h3>
              <p className="mt-3 text-[16px] leading-relaxed text-muted">{current.intro}</p>
              <div className="mt-6 flex flex-wrap gap-2">
                {current.uses.map((u) => (
                  <span
                    key={u}
                    className="rounded-full bg-accent-soft px-3 py-1 text-[13px] font-medium text-accent"
                  >
                    {u}
                  </span>
                ))}
              </div>
            </div>
            <ul className="divide-y divide-border border-y border-border">
              {current.prompts.map((p) => (
                <li key={p} className="flex items-start gap-3 py-4 text-[15.5px]">
                  <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  <span>“{p}”</span>
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------ How it works */

const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: PenLine,
    title: 'Ask or describe a task',
    text: 'Type, speak or attach a file. Plain language is all it takes.',
  },
  {
    icon: Layers,
    title: 'Atlas picks the right tools',
    text: 'It decides whether to search, read your document, create an image or simply answer, and which model to use.',
  },
  {
    icon: Search,
    title: 'It finds or creates the answer',
    text: 'Results stream in as they are written, with sources for anything from the web.',
  },
  {
    icon: ListChecks,
    title: 'You review and refine',
    text: 'Check the sources, ask a follow-up, translate, save or listen to it.',
  },
];

function HowItWorks() {
  const reduce = useReducedMotion();
  return (
    <section className="py-20 sm:py-28" aria-labelledby="how-title">
      <Container>
        <Reveal>
          <SectionHeading
            align="center"
            eyebrow="How it works"
            title={<span id="how-title">From question to result in four steps.</span>}
          />
        </Reveal>
        <ol className="relative mt-16 grid gap-10 md:grid-cols-4 md:gap-6">
          <motion.div
            aria-hidden="true"
            className="absolute top-6 right-[12%] left-[12%] hidden h-px origin-left bg-gradient-to-r from-accent/60 via-[#22d3ee]/60 to-accent/10 md:block"
            initial={reduce ? false : { scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.4, ease: [0.2, 0.7, 0.2, 1] }}
          />
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <li key={title}>
              <Reveal delay={i * 0.12} className="relative text-center">
                <span className="relative mx-auto flex size-12 items-center justify-center rounded-2xl border border-border bg-elevated text-accent shadow-[0_8px_24px_-14px_rgba(7,19,18,0.4)]">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <p className="t-eyebrow mt-5 text-subtle">Step {i + 1}</p>
                <h3 className="mt-2 text-[17px] font-semibold tracking-tight">{title}</h3>
                <p className="mx-auto mt-2 max-w-[240px] text-[14.5px] leading-relaxed text-muted">
                  {text}
                </p>
              </Reveal>
            </li>
          ))}
        </ol>
        <Reveal className="mx-auto mt-16 max-w-xl">
          <TypedComposer />
        </Reveal>
      </Container>
    </section>
  );
}

/* --------------------------------------------------------------- Why Atlas */

const WHY: { title: string; text: string }[] = [
  {
    title: 'Many capabilities, one workspace',
    text: 'Chat, search, research, documents, images and voice share the same conversation and context.',
  },
  {
    title: 'Access to capable models',
    text: 'Google Gemini by default, with free models through OpenRouter and automatic switching when a task needs it.',
  },
  {
    title: 'Research you can check',
    text: 'Sources on every web answer, checked news dates and Deep Research reports with citations.',
  },
  {
    title: 'No surprise costs',
    text: 'Atlas AI uses free models only, enforced on the server for every request.',
  },
  {
    title: 'Flexible ways to work',
    text: 'Type, talk, attach files or translate. Use it in the browser or install it as an app.',
  },
  {
    title: 'Improving every week',
    text: 'New capabilities ship often, and every release is listed with its date in the changelog.',
  },
];

function WhyAtlas() {
  return (
    <section className="border-t border-border py-20 sm:py-28" aria-labelledby="why-title">
      <Container>
        <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <Reveal>
            <SectionHeading
              eyebrow="Why Atlas AI"
              title={<span id="why-title">Less switching. More thinking.</span>}
              lead="Atlas AI is built around a simple idea: the tools for understanding and creating should work together."
            />
            <Link
              to="/changelog"
              className="mt-8 inline-flex items-center gap-1 rounded text-sm font-medium text-accent hover:underline"
            >
              See the changelog <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </Reveal>
          <div className="grid gap-x-10 gap-y-10 sm:grid-cols-2">
            {WHY.map((w, i) => (
              <Reveal key={w.title} delay={(i % 2) * 0.06} className="border-t border-border pt-6">
                <span className="font-mono text-xs text-subtle">0{i + 1}</span>
                <h3 className="mt-3 text-[17px] font-semibold tracking-tight">{w.title}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{w.text}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

/* --------------------------------------------------------------- Security */

const SECURITY: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: UserCheck,
    title: 'Verified, reviewed accounts',
    text: 'Phone verification by SMS, email codes and review before access.',
  },
  {
    icon: Lock,
    title: 'Your data stays yours',
    text: 'Database rules limit each account to its own data. Administrators cannot read your chats in the app.',
  },
  {
    icon: Bell,
    title: 'Sign-in alerts',
    text: 'An email when your account is used on a new device.',
  },
  {
    icon: Fingerprint,
    title: 'Sessions you control',
    text: 'See your devices, remove one, or sign out everywhere.',
  },
  {
    icon: ShieldCheck,
    title: 'Keys stay on the server',
    text: 'AI and search keys never reach your browser; every request is checked and rate limited.',
  },
  {
    icon: Sparkles,
    title: 'Analytics only with consent',
    text: 'No advertising cookies. Google Analytics runs only if you allow it.',
  },
];

function SecurityPreview() {
  return (
    <section className="bg-surface/70 py-20 sm:py-28" aria-labelledby="sec-title">
      <Container>
        <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <Reveal>
            <SectionHeading
              eyebrow="Security & privacy"
              title={<span id="sec-title">Careful with your account and your data.</span>}
              lead="What is in place today, described plainly. No badges we have not earned."
            />
          </Reveal>
          <Reveal className="flex flex-wrap gap-2">
            <Link to="/trust" className="btn btn-dark btn-sm">
              Trust Centre
            </Link>
            <Link to="/privacy" className="btn btn-light btn-sm">
              Privacy Policy
            </Link>
            <Link to="/docs/data-and-privacy" className="btn btn-light btn-sm">
              Data handling
            </Link>
          </Reveal>
        </div>
        <div className="mt-14 grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {SECURITY.map(({ icon: Icon, title, text }, i) => (
            <Reveal key={title} delay={(i % 3) * 0.06}>
              <div className="h-full border-t border-border pt-6">
                <Icon className="size-5 text-accent" strokeWidth={1.75} aria-hidden="true" />
                <h3 className="mt-4 text-[16.5px] font-semibold tracking-tight">{title}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{text}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-8 text-sm text-muted">
          Read the details on the{' '}
          <Link to="/trust#security" className="text-accent hover:underline">
            security page
          </Link>
          .
        </p>
      </Container>
    </section>
  );
}

/* --------------------------------------------------------------- Final CTA */

export function FinalCta() {
  return (
    <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="night relative mx-auto max-w-[1200px] overflow-hidden rounded-[36px] px-6 py-20 text-center sm:px-12 sm:py-28">
        <div
          className="pointer-events-none absolute -top-40 left-1/2 size-[520px] -translate-x-1/2 rounded-full bg-[#2dd4bf]/20 blur-3xl"
          aria-hidden="true"
        />
        <Reveal className="relative">
          <h2 className="t-h1 mx-auto max-w-3xl text-balance">Your next idea starts here.</h2>
          <p className="t-lead mx-auto mt-5 max-w-xl text-muted">
            Bring your questions, projects and ideas. Let Atlas AI help you take them further.
          </p>
          <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
            <Link to={APP_LINKS.register} className="btn btn-teal btn-lg">
              Get started with Atlas AI <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link to="/docs/getting-started" className="btn btn-ghost-night btn-lg">
              Read the guide
            </Link>
          </div>
          <div className="mx-auto mt-14 max-w-md opacity-90" aria-hidden="true">
            <ComposerMock text="" />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <>
      <Seo title={HOME.title} description={HOME.description} path="/" />
      <Hero />
      <IntegrationMarquee />
      <ProductIntro />
      <ResearchShowcase />
      <VoiceBand />
      <Bento />
      <UseCases />
      <HowItWorks />
      <WhyAtlas />
      <InAction />
      <SecurityPreview />
      <FinalCta />
    </>
  );
}

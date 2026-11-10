/**
 * Coded previews of real Atlas AI screens (chat, Sources, Deep Research,
 * documents, images, Voice Mode). They mirror the app's own layout and
 * controls; every element shown exists in the product. Decorative: hidden
 * from assistive technology, with the surrounding copy describing them.
 */
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowUp,
  AudioLines,
  Check,
  FileText,
  Globe,
  ImageIcon,
  Mic,
  PanelLeft,
  Plus,
  Search,
  Sparkles,
  SquarePen,
  Telescope,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { LogoMark } from '@/components/Logo';
import { cn } from '@/lib/utils';

function Chrome({ children, className, title = 'chatatlasai.vercel.app' }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={cn('shadow-panel overflow-hidden rounded-2xl border border-[#e3dfd4] bg-white text-[#1a1a1c]', className)}>
      <div className="flex h-9 items-center gap-2 border-b border-[#ecebe6] bg-[#f7f7f6] px-3">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-[#e4e2dc]" />
          <span className="size-2.5 rounded-full bg-[#e4e2dc]" />
          <span className="size-2.5 rounded-full bg-[#e4e2dc]" />
        </span>
        <span className="mx-auto rounded-md bg-white px-3 py-0.5 font-mono text-[10.5px] text-[#8a8a90]">{title}</span>
        <span className="w-10" />
      </div>
      {children}
    </div>
  );
}

/** The message box as it appears in the app. */
export function ComposerMock({ text, typing, compact }: { text: string; typing?: boolean; compact?: boolean }) {
  return (
    <div className="rounded-[22px] border border-[#e7e7e4] bg-white p-2 shadow-[0_1px_2px_rgba(20,20,25,0.04),0_8px_24px_-12px_rgba(20,20,25,0.12)]">
      <p className={cn('px-2.5 pt-1.5 pb-2 text-[13.5px]', text ? 'text-[#1a1a1c]' : 'text-[#9c9ca2]')}>
        {text || 'Message Atlas AI'}
        {typing && <span className="caret ml-px inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-[#0f766e]" />}
      </p>
      <div className="flex items-center gap-1 text-[#64646a]">
        <span className="flex size-7 items-center justify-center rounded-full border border-[#e7e7e4]">
          <Plus className="size-3.5" />
        </span>
        <span className="flex h-7 items-center gap-1 rounded-full border border-[#0f766e]/25 bg-[#0f766e]/[0.07] px-2 text-[11px] font-medium text-[#0f766e]">
          <Globe className="size-3.5" /> Search
        </span>
        {!compact && (
          <span className="flex h-7 items-center gap-1 rounded-full border border-[#e7e7e4] px-2 text-[11px]">
            <Telescope className="size-3.5" /> Deep Research
          </span>
        )}
        <span className="ml-auto flex size-7 items-center justify-center rounded-full">
          <Mic className="size-3.5" />
        </span>
        <span className="flex size-7 items-center justify-center rounded-full">
          <AudioLines className="size-3.5" />
        </span>
        <span className="flex size-7 items-center justify-center rounded-full bg-[#0f766e] text-white">
          <ArrowUp className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

const SITES = [
  { l: 'P', c: '#3776ab' },
  { l: 'R', c: '#ff4500' },
  { l: 'W', c: '#111' },
  { l: 'M', c: '#0f766e' },
];

export function SourcesButton() {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#e7e7e4] bg-white pr-2.5 pl-1 text-[11.5px] text-[#64646a]">
      <span className="flex -space-x-1.5">
        {SITES.map((s) => (
          <span key={s.l} className="flex size-[18px] items-center justify-center rounded-full border-2 border-white text-[8px] font-bold text-white" style={{ background: s.c }}>
            {s.l}
          </span>
        ))}
      </span>
      Sources
    </span>
  );
}

const SIDEBAR = ['Python learning plan', 'Q3 report summary', 'Trip to Kumasi', 'Fix the login bug', 'Essay outline'];

/** Desktop app: sidebar, a web answer with sources, and the composer. */
export function AppWindow({ className }: { className?: string }) {
  return (
    <Chrome className={className}>
      <div className="grid h-[420px] grid-cols-[180px_1fr] max-md:grid-cols-1 sm:h-[460px]">
        <aside className="flex flex-col border-r border-[#ecebe6] bg-[#f7f7f6] p-3 max-md:hidden">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold">
              <LogoMark className="size-5" /> Atlas <span className="text-[#0f766e]">AI</span>
            </span>
            <PanelLeft className="size-3.5 text-[#9c9ca2]" />
          </div>
          <span className="mt-4 flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-[12px] shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
            <SquarePen className="size-3.5" /> New chat
          </span>
          <span className="mt-1 flex items-center gap-2 px-2 py-1.5 text-[12px] text-[#64646a]">
            <Search className="size-3.5" /> Search chats
          </span>
          <p className="mt-4 px-2 text-[10px] font-medium text-[#9c9ca2]">Today</p>
          {SIDEBAR.map((s, i) => (
            <span key={s} className={cn('truncate rounded-lg px-2 py-1.5 text-[12px]', i === 0 ? 'bg-[#efefed] text-[#1a1a1c]' : 'text-[#64646a]')}>
              {s}
            </span>
          ))}
        </aside>
        <div className="flex min-w-0 flex-col">
          <div className="flex h-11 items-center justify-center gap-1 text-[12px] text-[#64646a]">
            Gemini Flash <span className="text-[#9c9ca2]">▾</span>
          </div>
          <div className="flex-1 space-y-4 overflow-hidden px-5 sm:px-8">
            <div className="flex justify-end">
              <p className="max-w-[80%] rounded-[20px] rounded-br-md bg-[#efefed] px-3.5 py-2 text-[13px]">What’s the best way to learn Python in 2026? Give me a 4-week plan.</p>
            </div>
            <div className="text-[13px] leading-relaxed">
              <p>Here’s a focused 4-week plan built on current, well-reviewed resources:</p>
              <ul className="mt-2 space-y-1.5">
                {[
                  ['Week 1', 'Syntax, data types and control flow with the official tutorial'],
                  ['Week 2', 'Functions, modules and files; build a small CLI tool'],
                  ['Week 3', 'Libraries: requests and pandas on a real dataset'],
                  ['Week 4', 'A capstone project and code review'],
                ].map(([w, t]) => (
                  <li key={w} className="flex gap-2">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#0f766e]" />
                    <span>
                      <b className="font-semibold">{w}:</b> {t}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center gap-2">
                <SourcesButton />
                <span className="text-[11px] text-[#9c9ca2]">Gemini</span>
              </div>
            </div>
          </div>
          <div className="px-4 pt-2 pb-4 sm:px-8">
            <ComposerMock text="" />
          </div>
        </div>
      </div>
    </Chrome>
  );
}

const STEPS = ['Planning 4 searches', 'Searching the web', 'Reading 6 pages', 'Writing the report'];

/** Deep Research progress, stepping through its stages. */
export function ResearchCard({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(reduce ? STEPS.length : 1);
  useEffect(() => {
    if (reduce) return;
    const t = window.setInterval(() => setStep((s) => (s >= STEPS.length + 1 ? 1 : s + 1)), 1300);
    return () => window.clearInterval(t);
  }, [reduce]);
  return (
    <div className={cn('shadow-panel w-[260px] rounded-2xl border border-[#e3dfd4] bg-white p-4 text-[#1a1a1c]', className)}>
      <div className="flex items-center gap-2 text-[12.5px] font-semibold">
        <span className="flex size-6 items-center justify-center rounded-lg bg-[#0f766e]/10 text-[#0f766e]">
          <Telescope className="size-3.5" />
        </span>
        Deep Research
      </div>
      <ol className="mt-3 space-y-2">
        {STEPS.map((s, i) => {
          const done = i < step - 1;
          const active = i === step - 1;
          return (
            <li key={s} className={cn('flex items-center gap-2 text-[12px] transition-colors', done || active ? 'text-[#1a1a1c]' : 'text-[#b4b4b8]')}>
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-full border transition-colors',
                  done ? 'border-[#0f766e] bg-[#0f766e] text-white' : active ? 'border-[#0f766e]' : 'border-[#dcdcd8]',
                )}
              >
                {done ? <Check className="size-2.5" strokeWidth={3} /> : active ? <span className="size-1.5 animate-pulse rounded-full bg-[#0f766e]" /> : null}
              </span>
              {s}
            </li>
          );
        })}
      </ol>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#efefed]">
        <motion.div className="h-full rounded-full bg-gradient-to-r from-[#0f766e] to-[#22d3ee]" animate={{ width: `${(Math.min(step, STEPS.length) / STEPS.length) * 100}%` }} transition={{ duration: 0.5 }} />
      </div>
    </div>
  );
}

/** A document attached to a question, as in the composer. */
export function DocumentCard({ className }: { className?: string }) {
  return (
    <div className={cn('shadow-panel w-[250px] rounded-2xl border border-[#e3dfd4] bg-white p-3.5 text-[#1a1a1c]', className)}>
      <div className="flex items-center gap-2.5 rounded-xl border border-[#ecebe6] bg-[#f7f7f6] p-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-[#dc2626]/10 text-[#b91c1c]">
          <FileText className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12px] font-medium">Annual-report-2025.pdf</span>
          <span className="block text-[10.5px] text-[#9c9ca2]">PDF · 2.4 MB · 48 pages</span>
        </span>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed">
        Revenue grew in three of four regions. The main risk the report names is <b className="font-semibold">supplier concentration</b> (p. 31).
      </p>
      <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-[#0f766e]/[0.08] px-2 py-0.5 text-[10.5px] font-medium text-[#0f766e]">
        <Check className="size-3" /> Read the whole document
      </p>
    </div>
  );
}

/** An image created in chat. The artwork is drawn with CSS, not a real output. */
export function ImageCard({ className }: { className?: string }) {
  return (
    <div className={cn('shadow-panel w-[220px] rounded-2xl border border-[#e3dfd4] bg-white p-2.5 text-[#1a1a1c]', className)}>
      <div className="relative aspect-square overflow-hidden rounded-xl" style={{ background: 'linear-gradient(180deg,#fde68a 0%,#fb923c 36%,#0e7490 66%,#082f49 100%)' }}>
        <div className="absolute inset-x-0 bottom-0 h-[38%] bg-[#0b1d2a]" />
        <div className="absolute bottom-[38%] left-1/2 size-[29%] -translate-x-1/2 translate-y-1/2 rounded-full bg-[#fff7d6] opacity-90 blur-[1px]" />
        <div className="absolute right-[22%] bottom-[38%] h-[46%] w-[7%] bg-[#f5f5f4]">
          <div className="absolute -top-2 left-1/2 h-2 w-[160%] -translate-x-1/2 rounded-t bg-[#0b1d2a]" />
          <div className="absolute top-[22%] h-[12%] w-full bg-[#b91c1c]" />
          <div className="absolute top-[52%] h-[12%] w-full bg-[#b91c1c]" />
        </div>
        <div className="absolute inset-x-0 bottom-[20%] h-px bg-white/20" />
      </div>
      <p className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-[#64646a]">
        <ImageIcon className="size-3.5" /> “A lighthouse at dawn, watercolour”
      </p>
    </div>
  );
}

/** The Voice Mode orb and bars. */
export function VoiceOrb({ className, label = 'Listening…' }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex flex-col items-center', className)}>
      <div className="relative flex size-28 items-center justify-center">
        <span className="pulse-ring absolute inset-0 rounded-full bg-[#2dd4bf]/30" />
        <span className="pulse-ring absolute inset-0 rounded-full bg-[#22d3ee]/20 [animation-delay:1.2s]" />
        <span className="relative flex size-24 items-center justify-center gap-1 rounded-full bg-[radial-gradient(circle_at_35%_30%,#5eead4,#0f766e_60%,#064e48)] shadow-[0_10px_40px_-10px_rgba(45,212,191,0.8)]">
          {[0.5, 0.9, 1, 0.7, 0.45].map((h, i) => (
            <span key={i} className="voice-bar w-1.5 rounded-full bg-white/90" style={{ height: `${h * 34}px`, animationDelay: `${i * 0.12}s` }} />
          ))}
        </span>
      </div>
      <p className="mt-4 text-[13px] text-current opacity-80">{label}</p>
    </div>
  );
}

/** Phone frame with the chat screen. */
export function PhoneMock({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <div className={cn('shadow-panel w-[230px] rounded-[34px] border-[6px] border-[#1c2523] bg-white p-0 text-[#1a1a1c]', className)}>
      <div className="relative overflow-hidden rounded-[28px]">
        <div className="flex h-7 items-center justify-between px-5 pt-1 text-[9px] font-semibold">
          <span>9:41</span>
          <span className="h-3.5 w-16 rounded-full bg-[#1c2523]" />
          <span>100%</span>
        </div>
        {children ?? (
          <div className="flex h-[380px] flex-col px-3 pb-3">
            <div className="flex h-9 items-center justify-center text-[11px] text-[#64646a]">Atlas AI</div>
            <div className="flex-1 space-y-3">
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-[16px] rounded-br-md bg-[#efefed] px-3 py-1.5 text-[11px]">Translate this into French</p>
              </div>
              <p className="text-[11px] leading-relaxed">
                <b className="font-semibold">Ordre du jour</b>
                <br />
                1. Bilan du trimestre
                <br />
                2. Budget 2026
                <br />
                3. Questions diverses
              </p>
              <p className="inline-flex items-center gap-1 rounded-full bg-[#0f766e]/[0.08] px-2 py-0.5 text-[9.5px] text-[#0f766e]">
                <Sparkles className="size-2.5" /> Formatting kept
              </p>
            </div>
            <ComposerMock text="" compact />
          </div>
        )}
      </div>
    </div>
  );
}

/** Rotating typed prompts for the hero composer. */
const PROMPTS = [
  'Summarise this 40-page report in five bullet points',
  'What changed in the news this morning?',
  'Explain this error and suggest a fix',
  'Create an image of a lighthouse at dawn',
  'Plan a 3-day trip to Cape Coast on a budget',
];

export function TypedComposer({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  const [n, setN] = useState(reduce ? PROMPTS[0].length : 0);
  useEffect(() => {
    if (reduce) return;
    const full = PROMPTS[i];
    const t = window.setTimeout(
      () => {
        if (n < full.length) setN(n + 1);
        else {
          setN(0);
          setI((i + 1) % PROMPTS.length);
        }
      },
      n < full.length ? 38 : 2200,
    );
    return () => window.clearTimeout(t);
  }, [i, n, reduce]);
  return (
    <div className={className} aria-hidden="true">
      <ComposerMock text={PROMPTS[i].slice(0, n)} typing={!reduce} />
    </div>
  );
}

/**
 * Decorative dot field for page headers: a round cloud of small dots that
 * thins out towards the edge, a few teal dots that softly pulse, and the
 * Atlas AI mark in the middle. Pure SVG, deterministic (same dots on every
 * render and in the prerendered HTML), still under prefers-reduced-motion.
 */
import { LogoMark } from '@/components/Logo';
import { cn } from '@/lib/utils';

const SIZE = 420;
const STEP = 13;

type Dot = { x: number; y: number; r: number; o: number; accent: boolean; delay: number };

// small seeded random so the pattern never changes between renders
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const DOTS: Dot[] = (() => {
  const rand = rng(7);
  const c = SIZE / 2;
  const out: Dot[] = [];
  for (let y = STEP / 2; y < SIZE; y += STEP) {
    for (let x = STEP / 2; x < SIZE; x += STEP) {
      const d = Math.hypot(x - c, (y - c) * 1.25) / c; // a little wider than tall
      if (d > 1) continue;
      const keep = d < 0.55 ? 0.95 : 1 - (d - 0.55) / 0.5;
      if (rand() > keep) continue;
      if (d < 0.14) continue; // room for the mark
      const accent = rand() < 0.07;
      out.push({ x, y, r: accent ? 2.1 : 1.4, o: accent ? 0.9 : 0.25 + (1 - d) * 0.4, accent, delay: rand() * 4 });
    }
  }
  // a few loose dots outside the cloud
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2;
    const r = c * (1.02 + rand() * 0.22);
    const x = c + Math.cos(a) * r;
    const y = c + (Math.sin(a) * r) / 1.25;
    if (x > 4 && x < SIZE - 4 && y > 4 && y < SIZE - 4) out.push({ x, y, r: 1.3, o: 0.3, accent: false, delay: 0 });
  }
  return out;
})();

export function DotField({ className }: { className?: string }) {
  return (
    <div className={cn('relative aspect-square w-full max-w-[420px] select-none', className)} aria-hidden="true">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-full text-fg">
        {DOTS.map((d, i) => (
          <circle
            key={i}
            cx={d.x}
            cy={d.y}
            r={d.r}
            className={d.accent ? 'dot-pulse fill-accent' : 'fill-current'}
            style={d.accent ? { opacity: d.o, animationDelay: `${d.delay}s` } : { opacity: d.o * 0.55 }}
          />
        ))}
      </svg>
      <div className="dot-mark absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <LogoMark className="size-12 drop-shadow-[0_8px_18px_rgba(0,0,0,0.25)]" />
      </div>
    </div>
  );
}

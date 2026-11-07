import { cn } from '@/lib/utils';

/**
 * Atlas AI mark: a rounded tile in the accent colour carrying a peak-shaped
 * "A" whose crossbar is an orbit arc (a map and globe reference: thinking
 * further, reaching further). Works from 16px favicons up to app icons.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8.5" className="fill-accent" />
      <path d="M9.2 24 16 8.2 22.8 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.6 19.4c5.2-3.1 13.6-3.1 18.8 0" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.75" />
    </svg>
  );
}

export function Logo({ className, showText = true }: { className?: string; showText?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark />
      {showText && (
        <span className="text-[17px] font-semibold tracking-tight">
          Atlas <span className="text-accent">AI</span>
        </span>
      )}
    </span>
  );
}

export const TAGLINE = 'Think further. Do more.';

import { cn } from '@/lib/utils';

/**
 * Tessera mark: four mosaic tiles (tesserae) on a 2x2 grid, one set in the
 * accent colour. The small offset tile suggests a piece being placed: the
 * assistant fitting information together.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden="true">
      <rect x="3" y="3" width="12" height="12" rx="3.2" className="fill-fg" />
      <rect x="17" y="3" width="12" height="12" rx="3.2" className="fill-fg" opacity="0.35" />
      <rect x="3" y="17" width="12" height="12" rx="3.2" className="fill-fg" opacity="0.35" />
      <rect x="18.5" y="18.5" width="11" height="11" rx="3" className="fill-accent" />
    </svg>
  );
}

export function Logo({ className, showText = true }: { className?: string; showText?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark />
      {showText && <span className="text-[17px] font-semibold tracking-tight">Tessera</span>}
    </span>
  );
}

/**
 * A real screenshot of the Atlas AI dashboard, light or dark to match the
 * site theme. Personal details (name and email in the account row) were
 * removed from the images before they were added.
 */
import { cn } from '@/lib/utils';

const ALT = 'The Atlas AI dashboard: the navigation on the left and a new chat with the message box';

export function DashboardShot({ className, priority }: { className?: string; priority?: boolean }) {
  return (
    <figure className={cn('relative overflow-hidden rounded-[14px] border border-border bg-bg shadow-[0_30px_80px_-30px_rgba(20,30,25,0.45)] ring-1 ring-black/[0.03] sm:rounded-[18px]', className)}>
      <img
        src="/photos/app-dashboard-light-2000.webp"
        srcSet="/photos/app-dashboard-light-1200.webp 1200w, /photos/app-dashboard-light-2000.webp 2000w"
        sizes="(min-width: 1100px) 1000px, 94vw"
        alt={ALT}
        width={1176}
        height={638}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : undefined}
        decoding="async"
        className="block h-auto w-full dark:hidden"
      />
      <img
        src="/photos/app-dashboard-dark-2000.webp"
        srcSet="/photos/app-dashboard-dark-1200.webp 1200w, /photos/app-dashboard-dark-2000.webp 2000w"
        sizes="(min-width: 1100px) 1000px, 94vw"
        alt={ALT}
        width={1182}
        height={636}
        loading="lazy"
        decoding="async"
        className="hidden h-auto w-full dark:block"
      />
    </figure>
  );
}

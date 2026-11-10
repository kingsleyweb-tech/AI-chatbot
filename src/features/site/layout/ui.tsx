import { motion, useReducedMotion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { Photo } from '../content/photos';
import { DotField } from './DotField';

/** Page-width wrapper with the site gutters. */
export function Container({ children, className, narrow }: { children: ReactNode; className?: string; narrow?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 sm:px-6 lg:px-8', narrow ? 'max-w-3xl' : 'max-w-[1200px]', className)}>{children}</div>;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('t-eyebrow inline-flex items-center gap-2 text-muted', className)}>
      <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
      {children}
    </p>
  );
}

/** Section title block: eyebrow, heading and lead. */
export function SectionHeading({
  eyebrow,
  title,
  lead,
  align = 'left',
  className,
  as: H = 'h2',
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: 'left' | 'center';
  className?: string;
  as?: 'h1' | 'h2';
}) {
  return (
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && <Eyebrow className={align === 'center' ? 'justify-center' : undefined}>{eyebrow}</Eyebrow>}
      <H className={cn(H === 'h1' ? 't-h1' : 't-h2', 'mt-4 text-balance text-fg')}>{title}</H>
      {lead && <p className="t-lead mt-4 text-pretty text-muted">{lead}</p>}
    </div>
  );
}

/** Fade-and-rise when scrolled into view. Plain markup under reduced motion. */
export function Reveal({ children, className, delay = 0, y = 22 }: { children: ReactNode; className?: string; delay?: number; y?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.7, delay, ease: [0.2, 0.7, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'border border-border bg-elevated text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'warn' && 'bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Top-of-page hero used by inner pages. */
export function PageHero({
  eyebrow,
  title,
  lead,
  children,
  crumbs,
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  crumbs?: { label: string; href?: string }[];
}) {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <Container className="relative grid items-center gap-10 pt-10 pb-14 sm:pt-14 sm:pb-20 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-16">
        <div className="min-w-0">
          {crumbs && <Breadcrumbs items={crumbs} className="mb-8" />}
          <SectionHeading as="h1" eyebrow={eyebrow} title={title} lead={lead} />
          {children && <div className="mt-8">{children}</div>}
        </div>
        <DotField className="mx-auto hidden lg:block" />
      </Container>
    </section>
  );
}

export function Breadcrumbs({ items, className }: { items: { label: string; href?: string }[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
        {items.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-subtle" aria-hidden="true" />}
            {c.href && i < items.length - 1 ? (
              <Link to={c.href} className="rounded hover:text-fg">
                {c.label}
              </Link>
            ) : (
              <span aria-current={i === items.length - 1 ? 'page' : undefined} className="text-fg">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Internal links use the router; everything else opens in a new tab. */
export function SmartLink({ href, children, className, ...rest }: { href: string; children: ReactNode; className?: string; 'aria-label'?: string }) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    return (
      <Link to={href} className={className} {...rest}>
        {children}
      </Link>
    );
  }
  const external = /^https?:/.test(href);
  return (
    <a href={href} className={className} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} {...rest}>
      {children}
    </a>
  );
}

export function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * A credited photograph (content/photos.ts), served as WebP at two widths.
 * Fills its box with object-cover; give the box an aspect ratio.
 */
export function SitePhoto({
  photo,
  className,
  sizes = '(min-width: 1024px) 50vw, 100vw',
  priority,
  zoom,
}: {
  photo: Photo;
  className?: string;
  sizes?: string;
  priority?: boolean;
  /** scale up slightly on hover of a parent .group */
  zoom?: boolean;
}) {
  return (
    <img
      src={`${photo.src}-1600.webp`}
      srcSet={`${photo.src}-800.webp 800w, ${photo.src}-1600.webp 1600w`}
      sizes={sizes}
      alt={photo.alt}
      width={1600}
      height={1067}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className={cn('size-full object-cover', zoom && 'transition-transform duration-700 ease-out group-hover:scale-[1.03] motion-reduce:transition-none', className)}
    />
  );
}

export function PhotoCredit({ photo, className }: { photo: Photo; className?: string }) {
  return (
    <p className={cn('text-xs text-subtle', className)}>
      Photo:{' '}
      <a href={photo.creditUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-border-strong underline-offset-2 hover:text-muted">
        {photo.credit} on Unsplash
      </a>
    </p>
  );
}

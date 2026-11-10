import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  AudioLines,
  Blocks,
  BookOpen,
  ChevronDown,
  Compass,
  FileText,
  Globe,
  History,
  ImageIcon,
  LifeBuoy,
  Mail,
  Menu,
  Newspaper,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Link, NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { APP_LINKS, NAV, type NavGroup, type NavLink } from '../content/site';

const ICONS: Record<string, LucideIcon> = { Activity, AudioLines, Blocks, BookOpen, Compass, FileText, Globe, History, ImageIcon, LifeBuoy, Mail, Newspaper, Sparkles };

const isGroup = (n: NavGroup | NavLink): n is NavGroup => 'columns' in n;

/** Sign-in buttons, or "Open Atlas AI" for someone already signed in. */
function AuthButtons({ stacked, onNavigate }: { stacked?: boolean; onNavigate?: () => void }) {
  const { access } = useAuth();
  if (access !== 'signed-out' && access !== 'loading') {
    return (
      <Link to="/" onClick={onNavigate} className={cn('btn btn-dark btn-sm', stacked && 'btn-lg w-full')}>
        Open Atlas AI <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    );
  }
  return (
    <div className={cn('flex items-center gap-2', stacked && 'flex-col-reverse items-stretch gap-3')}>
      <Link to={APP_LINKS.login} onClick={onNavigate} className={cn('btn btn-sm text-fg hover:bg-fg/[0.05]', stacked && 'btn-lg btn-light')}>
        Sign in
      </Link>
      <Link to={APP_LINKS.register} onClick={onNavigate} className={cn('btn btn-dark btn-sm', stacked && 'btn-lg')}>
        Start using Atlas AI
      </Link>
    </div>
  );
}

function Dropdown({ group, open, onOpen, onClose }: { group: NavGroup; open: boolean; onOpen: () => void; onClose: () => void }) {
  const id = useId();
  const reduce = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={wrap}
      className="static"
      onMouseEnter={onOpen}
      onMouseLeave={onClose}
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node)) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          onClose();
          wrap.current?.querySelector('button')?.focus();
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? onClose() : onOpen())}
        className={cn('flex h-9 items-center gap-1 rounded-lg px-3 text-[15px] text-fg/75 transition-colors hover:bg-fg/[0.05] hover:text-fg', open && 'bg-fg/[0.05] text-fg')}
      >
        {group.label}
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
            className="absolute top-full left-1/2 z-50 -translate-x-1/2 pt-3"
          >
            <div className="shadow-panel grid w-[600px] max-w-[calc(100vw-2rem)] grid-cols-2 gap-x-4 gap-y-2 rounded-2xl border border-border bg-bg p-4">
              {group.columns.map((col) => (
                <div key={col.heading}>
                  <p className="t-eyebrow px-3 pt-2 pb-2 text-subtle">{col.heading}</p>
                  <ul>
                    {col.links.map((l) => {
                      const Icon = l.icon ? ICONS[l.icon] : null;
                      return (
                        <li key={l.href}>
                          <Link to={l.href} onClick={onClose} className="group flex gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface">
                            {Icon && <Icon className="mt-[3px] size-[18px] shrink-0 text-subtle transition-colors group-hover:text-accent" strokeWidth={1.6} aria-hidden="true" />}
                            <span className="min-w-0">
                              <span className="block text-[15px] font-medium tracking-[-0.01em] text-fg">{l.label}</span>
                              {l.description && <span className="mt-0.5 block text-[13px] leading-snug text-muted">{l.description}</span>}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Full-screen menu for phones and tablets: focus stays inside, Esc closes. */
function MobileNavigation({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    el?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          id="site-mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Site menu"
          initial={reduce ? false : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-x-0 top-0 bottom-0 z-[60] flex flex-col bg-bg pt-safe lg:hidden"
        >
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
            <Link to="/" onClick={onClose} aria-label="Atlas AI home">
              <Logo />
            </Link>
            <button type="button" onClick={onClose} className="flex size-10 items-center justify-center rounded-xl hover:bg-surface" aria-label="Close menu">
              <X className="size-5" />
            </button>
          </div>
          <nav aria-label="Main" className="flex-1 overflow-y-auto px-4 py-4">
            <ul className="divide-y divide-border">
              {NAV.map((n) =>
                isGroup(n) ? (
                  <li key={n.label}>
                    <button
                      type="button"
                      aria-expanded={expanded === n.label}
                      onClick={() => setExpanded((x) => (x === n.label ? null : n.label))}
                      className="flex w-full items-center justify-between py-4 text-left text-lg font-medium"
                    >
                      {n.label}
                      <ChevronDown className={cn('size-5 text-muted transition-transform', expanded === n.label && 'rotate-180')} aria-hidden="true" />
                    </button>
                    {expanded === n.label && (
                      <div className="grid gap-5 pb-5 sm:grid-cols-2">
                        {n.columns.map((col) => (
                          <div key={col.heading}>
                            <p className="t-eyebrow mb-2 text-subtle">{col.heading}</p>
                            <ul className="space-y-1">
                              {col.links.map((l) => (
                                <li key={l.href}>
                                  <Link to={l.href} onClick={onClose} className="block rounded-lg py-2 text-[15px] text-fg/85 hover:text-fg">
                                    {l.label}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                ) : (
                  <li key={n.href}>
                    <Link to={n.href} onClick={onClose} className="block py-4 text-lg font-medium">
                      {n.label}
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </nav>
          <div className="shrink-0 border-t border-border p-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
            <AuthButtons stacked onNavigate={onClose} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function PublicHeader({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 8);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  // Close menus on navigation, and lock the page scroll under the mobile menu.
  useEffect(() => {
    setOpenMenu(null);
    setMobile(false);
  }, [pathname]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.style.overflowY = mobile ? 'hidden' : '';
  }, [mobile, scrollRef]);

  return (
    <>
    <header
      className={cn(
        'sticky top-0 z-50 pt-safe transition-[background,box-shadow,border-color] duration-300',
        scrolled ? 'border-b border-border bg-bg/85 backdrop-blur-xl' : 'border-b border-transparent bg-bg/0',
      )}
    >
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-4 px-4 sm:px-6 lg:grid lg:h-[72px] lg:grid-cols-[1fr_auto_1fr] lg:px-8">
        <Link to="/" className="shrink-0 justify-self-start rounded-lg" aria-label="Atlas AI home">
          <Logo className="[&_svg]:size-8 [&>span:last-child]:text-[19px]" />
        </Link>

        <nav aria-label="Main" className="relative hidden items-center gap-1 lg:flex">
          {NAV.map((n) =>
            isGroup(n) ? (
              <Dropdown key={n.label} group={n} open={openMenu === n.label} onOpen={() => setOpenMenu(n.label)} onClose={() => setOpenMenu((m) => (m === n.label ? null : m))} />
            ) : (
              <RouterNavLink
                key={n.href}
                to={n.href}
                className={({ isActive }) => cn('flex h-9 items-center rounded-lg px-3 text-[15px] text-fg/75 transition-colors hover:bg-fg/[0.05] hover:text-fg', isActive && 'text-fg')}
              >
                {n.label}
              </RouterNavLink>
            ),
          )}
        </nav>

        <div className="hidden justify-self-end lg:block">
          <AuthButtons />
        </div>

        <div className="ml-auto flex items-center gap-2 lg:hidden">
          <Link to={APP_LINKS.login} className="btn btn-sm btn-light hidden sm:inline-flex">
            Sign in
          </Link>
          <button
            type="button"
            onClick={() => setMobile(true)}
            aria-expanded={mobile}
            aria-controls="site-mobile-menu"
            className="flex size-10 items-center justify-center rounded-xl border border-border bg-elevated"
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
        </div>
      </div>
    </header>
    {/* outside the header: its backdrop blur would trap a fixed overlay */}
    <MobileNavigation open={mobile} onClose={() => setMobile(false)} />
    </>
  );
}

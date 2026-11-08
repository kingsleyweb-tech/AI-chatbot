import { ArrowLeft, Menu as MenuIcon, PanelLeftOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useShell } from './AppShell';

/** Scrollable page frame for non-chat screens, with a mobile top bar. */
export function Page({
  title,
  children,
  back,
  actions,
  wide,
  className,
}: {
  title: string;
  children: ReactNode;
  back?: string;
  actions?: ReactNode;
  wide?: boolean;
  /** extra classes for the page background */
  className?: string;
}) {
  const shell = useShell();
  const navigate = useNavigate();
  const showBar = !shell.isDesktop || shell.sidebarCollapsed || back;
  return (
    <div className={cn('flex h-full flex-col', className)}>
      {showBar && (
        <header className="flex shrink-0 items-center gap-1 px-2 pt-safe sm:px-3">
          <div className="flex h-14 min-w-0 flex-1 items-center gap-1">
            {back ? (
              <IconButton label="Back" onClick={() => navigate(back)}>
                <ArrowLeft className="size-5" />
              </IconButton>
            ) : !shell.isDesktop ? (
              <IconButton label="Open menu" onClick={shell.openNav}>
                <MenuIcon className="size-5" />
              </IconButton>
            ) : (
              <IconButton label="Open sidebar" onClick={shell.toggleSidebar}>
                <PanelLeftOpen className="size-[18px]" />
              </IconButton>
            )}
            <span className="truncate text-[15px] font-medium lg:hidden">{title}</span>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1 lg:hidden">{actions}</div>}
        </header>
      )}
      <div className="scroll-thin touch-scroll min-h-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto w-full px-4 pb-safe-12 pt-4 sm:px-6 lg:pt-10', wide ? 'max-w-5xl' : 'max-w-3xl')}>{children}</div>
      </div>
    </div>
  );
}

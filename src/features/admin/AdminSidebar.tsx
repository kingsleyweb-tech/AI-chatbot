import {
  Activity,
  Layers,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  Gauge,
  HeartPulse,
  Infinity as InfinityIcon,
  LayoutDashboard,
  Library,
  LifeBuoy,
  MailCheck,
  Megaphone,
  MessageSquareText,
  Newspaper,
  PanelLeftClose,
  ScrollText,
  ShieldCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { IconButton } from '@/components/ui';
import { useAuth } from '@/state/auth';
import { NavItem, useNewReports, usePendingRequests } from '../shell/Sidebar';

const icon = 'size-[17px]';

function Heading({ children }: { children: string }) {
  return <div className="px-2.5 pb-1 pt-4 text-[11px] font-medium tracking-wide text-subtle uppercase">{children}</div>;
}

/**
 * The Admin Dashboard's own menu (a separate layout from the AI workspace). Every page here is
 * administrator-only, and every action is checked again by the server.
 */
export function AdminSidebar({ onClose, onCollapse }: { onClose?: () => void; onCollapse?: () => void }) {
  const { admin } = useAuth();
  const pending = usePendingRequests(admin);
  const reports = useNewReports(admin);
  const close = () => onClose?.();
  return (
    <div className="flex h-full flex-col pt-safe pl-safe">
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <Link to="/admin" className="flex items-center gap-2 rounded-lg px-1.5 py-1" aria-label="Admin Dashboard overview" onClick={close}>
          <Logo />
        </Link>
        {onClose ? (
          <IconButton label="Close menu" onClick={onClose}>
            <X className="size-[18px]" />
          </IconButton>
        ) : (
          <IconButton label="Collapse sidebar" onClick={onCollapse}>
            <PanelLeftClose className="size-[18px]" />
          </IconButton>
        )}
      </div>

      <div className="px-2 pb-2">
        <Link
          to="/"
          onClick={close}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg border border-border px-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
        >
          <ArrowLeft className={icon} />
          Back to AI workspace
        </Link>
      </div>

      <nav aria-label="Admin Dashboard" className="scroll-thin touch-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
        {admin && (
          <>
            <div className="space-y-0.5 pt-1">
              <NavItem to="/admin" icon={<LayoutDashboard className={icon} />} label="Overview" onClick={close} end />
            </div>
            <Heading>Access</Heading>
            <div className="space-y-0.5">
              <NavItem to="/admin/users" icon={<Users className={icon} />} label="User Management" onClick={close} />
              <NavItem to="/admin/requests" icon={<UserPlus className={icon} />} label="Access Requests" count={pending} onClick={close} />
              <NavItem to="/admin/access" icon={<ShieldCheck className={icon} />} label="Access & Registration" onClick={close} />
              <NavItem to="/admin/ownership" icon={<BadgeCheck className={icon} />} label="Ownership Record" onClick={close} />
            </div>
            <Heading>AI Usage</Heading>
            <div className="space-y-0.5">
              <NavItem to="/admin/usage" icon={<Gauge className={icon} />} label="AI Usage & Limits" onClick={close} />
              <NavItem to="/admin/unlimited" icon={<InfinityIcon className={icon} />} label="Unlimited Access" onClick={close} />
              <NavItem to="/admin/analytics" icon={<BarChart3 className={icon} />} label="Usage Analytics" onClick={close} />
            </div>
            <Heading>Content</Heading>
            <div className="space-y-0.5">
              <NavItem to="/admin/news" icon={<Newspaper className={icon} />} label="News Sources" onClick={close} />
              <NavItem to="/admin/knowledge-center" icon={<Library className={icon} />} label="Knowledge Management" onClick={close} />
            </div>
            <Heading>Communication</Heading>
            <div className="space-y-0.5">
              <NavItem to="/admin/support" icon={<LifeBuoy className={icon} />} label="Support & Reports" count={reports} onClick={close} />
              <NavItem to="/admin/messages" icon={<Megaphone className={icon} />} label="Messages to Users" onClick={close} />
              <NavItem to="/admin/sms" icon={<MessageSquareText className={icon} />} label="SMS & Verification" onClick={close} />
              <NavItem to="/admin/email" icon={<MailCheck className={icon} />} label="Email Delivery" onClick={close} />
            </div>
            <Heading>System</Heading>
            <div className="space-y-0.5">
              <NavItem to="/admin/providers" icon={<Activity className={icon} />} label="Provider Monitoring" onClick={close} />
              <NavItem to="/admin/environments" icon={<Layers className={icon} />} label="API Environments" onClick={close} />
              <NavItem to="/admin/health" icon={<HeartPulse className={icon} />} label="System Health" onClick={close} />
              <NavItem to="/admin/logs" icon={<ScrollText className={icon} />} label="Audit Logs" onClick={close} />
            </div>
          </>
        )}
      </nav>
    </div>
  );
}


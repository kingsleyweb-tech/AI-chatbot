import { AnimatePresence, motion } from 'framer-motion';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useIsDesktop } from '@/lib/viewport';
import { NotificationsProvider } from '../notifications/useNotifications';
import { EmailReminder } from './EmailReminder';
import { PhoneReminder } from './PhoneReminder';
import { SearchDialog } from './SearchDialog';
import { Sidebar } from './Sidebar';

interface ShellCtx {
  openNav: () => void;
  openSearch: () => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  isDesktop: boolean;
}
const Ctx = createContext<ShellCtx | null>(null);
export const useShell = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShell outside AppShell');
  return v;
};

export default function AppShell() {
  const isDesktop = useIsDesktop();
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('tessera.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname, location.search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('tessera.sidebar', c ? 'open' : 'collapsed');
      } catch {
        /* ignore */
      }
      return !c;
    });
  }, []);

  const ctx: ShellCtx = {
    openNav: () => setNavOpen(true),
    openSearch: () => setSearchOpen(true),
    sidebarCollapsed: collapsed,
    toggleSidebar,
    isDesktop,
  };

  return (
    <Ctx.Provider value={ctx}>
      <NotificationsProvider>
        <div className="flex h-full w-full overflow-hidden bg-bg">
          {isDesktop ? (
            <motion.aside
              initial={false}
              animate={{ width: collapsed ? 0 : 272 }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="h-full shrink-0 overflow-hidden border-r border-border bg-surface"
            >
              <div className="h-full w-[272px]">
                <Sidebar onSearch={() => setSearchOpen(true)} onCollapse={toggleSidebar} />
              </div>
            </motion.aside>
          ) : (
            <AnimatePresence>
              {navOpen && (
                <>
                  <motion.div
                    className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    onClick={() => setNavOpen(false)}
                  />
                  <motion.aside
                    className="fixed inset-y-0 left-0 z-50 w-[86vw] max-w-[320px] border-r border-border bg-surface shadow-2xl"
                    initial={{ x: '-100%' }}
                    animate={{ x: 0 }}
                    exit={{ x: '-100%' }}
                    transition={{ type: 'spring', damping: 34, stiffness: 360 }}
                    drag="x"
                    dragConstraints={{ left: 0, right: 0 }}
                    dragElastic={{ left: 0.3, right: 0 }}
                    onDragEnd={(_, info) => {
                      if (info.offset.x < -80 || info.velocity.x < -400) setNavOpen(false);
                    }}
                  >
                    <Sidebar
                      onSearch={() => setSearchOpen(true)}
                      onClose={() => setNavOpen(false)}
                    />
                  </motion.aside>
                </>
              )}
            </AnimatePresence>
          )}
          <main className="relative flex h-full min-w-0 flex-1 flex-col">
            <Outlet />
          </main>
        </div>
        <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
        <PhoneReminder />
        <EmailReminder />
      </NotificationsProvider>
    </Ctx.Provider>
  );
}

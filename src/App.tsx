import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LogoMark } from './components/Logo';
import { useVisualViewport } from './lib/viewport';
import { AuthProvider, useAuth } from './state/auth';
import { CatalogProvider } from './state/catalog';
import { SettingsProvider } from './state/settings';
import { ToastProvider } from './state/toast';

const AuthPages = lazy(() => import('./features/auth/AuthPages'));
const AppShell = lazy(() => import('./features/shell/AppShell'));
const ChatPage = lazy(() => import('./features/chat/ChatPage'));
const MemoryPage = lazy(() => import('./features/memory/MemoryPage'));
const ProjectsPage = lazy(() => import('./features/projects/ProjectsPage'));
const ProjectPage = lazy(() => import('./features/projects/ProjectPage'));
const SavedPage = lazy(() => import('./features/saved/SavedPage'));
const DocumentsPage = lazy(() => import('./features/documents/DocumentsPage'));
const KnowledgePage = lazy(() => import('./features/knowledge/KnowledgePage'));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'));
const UsersPage = lazy(() => import('./features/admin/UsersPage'));
const AccessRequestsPage = lazy(() => import('./features/admin/AccessRequestsPage'));
const SupportAdminPage = lazy(() => import('./features/admin/SupportAdminPage'));
const SupportReportAdminPage = lazy(() => import('./features/admin/SupportReportAdminPage'));
const ReportIssuePage = lazy(() => import('./features/support/ReportIssuePage'));
const MyReportsPage = lazy(() => import('./features/support/MyReportsPage'));
const ReportThreadPage = lazy(() => import('./features/support/ReportThreadPage'));
const NotificationsPage = lazy(() => import('./features/notifications/NotificationsPage'));
const HelpPage = lazy(() => import('./features/help/HelpPage'));
const LegalPage = lazy(() => import('./features/legal/LegalPage'));

export function Splash() {
  return (
    <div className="flex h-full items-center justify-center">
      <LogoMark className="size-9 animate-pulse" />
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { access } = useAuth();
  const location = useLocation();
  if (access === 'loading') return <Splash />;
  if (access === 'signed-out') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (access === 'phone') return <Navigate to="/verify-phone" replace />;
  if (access === 'unverified') return <Navigate to="/verify" replace />;
  if (access === 'request' || access === 'pending' || access === 'rejected') return <Navigate to="/request-access" replace />;
  if (access === 'denied' || access === 'error' || access === 'suspended' || access === 'deleted') return <Navigate to="/denied" replace />;
  return <>{children}</>;
}

/**
 * Fetch the main app screens while the browser is idle, so opening the app
 * (after sign-in or approval) is instant and uses chunks of this same build.
 */
function usePrefetchApp() {
  const { access } = useAuth();
  const ready = access !== 'loading' && access !== 'signed-out';
  useEffect(() => {
    if (!ready) return;
    const load = () => {
      void import('./features/shell/AppShell').catch(() => undefined);
      void import('./features/chat/ChatPage').catch(() => undefined);
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(load, { timeout: 3000 });
    else window.setTimeout(load, 1500);
  }, [ready]);
}

function Routed() {
  useVisualViewport();
  usePrefetchApp();
  return (
    <div className="app-frame">
      <ErrorBoundary>
        <Suspense fallback={<Splash />}>
          <Routes>
            <Route path="/login" element={<AuthPages mode="login" />} />
            <Route path="/register" element={<AuthPages mode="register" />} />
            <Route path="/reset" element={<AuthPages mode="reset" />} />
            <Route path="/verify" element={<AuthPages mode="verify" />} />
            <Route path="/verify-phone" element={<AuthPages mode="phone" />} />
            <Route path="/denied" element={<AuthPages mode="denied" />} />
            <Route path="/request-access" element={<AuthPages mode="request" />} />
            <Route path="/privacy" element={<LegalPage doc="privacy" />} />
            <Route path="/terms" element={<LegalPage doc="terms" />} />
            <Route
              element={
                <Protected>
                  <AppShell />
                </Protected>
              }
            >
              <Route index element={<ChatPage />} />
              <Route path="c/:conversationId" element={<ChatPage />} />
              <Route path="memory" element={<MemoryPage />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="projects/:projectId" element={<ProjectPage />} />
              <Route path="saved" element={<SavedPage />} />
              <Route path="documents" element={<DocumentsPage />} />
              <Route path="knowledge" element={<KnowledgePage />} />
              <Route path="settings/:section?" element={<SettingsPage />} />
              <Route path="admin/users" element={<UsersPage />} />
              <Route path="admin/requests" element={<AccessRequestsPage />} />
              <Route path="admin/support" element={<SupportAdminPage />} />
              <Route path="admin/support/:ref" element={<SupportReportAdminPage />} />
              <Route path="support" element={<MyReportsPage />} />
              <Route path="support/new" element={<ReportIssuePage />} />
              <Route path="support/:ref" element={<ReportThreadPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="help" element={<HelpPage />} />
              <Route path="help/:id" element={<HelpPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <SettingsProvider>
            <CatalogProvider>
              <Routed />
            </CatalogProvider>
          </SettingsProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

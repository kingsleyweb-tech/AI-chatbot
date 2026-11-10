import { lazy, Suspense, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { AnalyticsConsentBanner } from './components/AnalyticsConsent';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SessionGuard } from './features/shell/SessionGuard';
import { LogoMark } from './components/Logo';
import { sessionEnding, subscribeSessionEnding } from './lib/session';
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
const ImagesPage = lazy(() => import('./features/images/ImagesPage'));
const DocumentsPage = lazy(() => import('./features/documents/DocumentsPage'));
const KnowledgePage = lazy(() => import('./features/knowledge/KnowledgePage'));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'));
const UsersPage = lazy(() => import('./features/admin/UsersPage'));
const AccessRequestsPage = lazy(() => import('./features/admin/AccessRequestsPage'));
const SupportAdminPage = lazy(() => import('./features/admin/SupportAdminPage'));
const SupportReportAdminPage = lazy(() => import('./features/admin/SupportReportAdminPage'));
const SmsAdminPage = lazy(() => import('./features/admin/SmsAdminPage'));
const EmailAdminPage = lazy(() => import('./features/admin/EmailAdminPage'));
const MessagesPage = lazy(() => import('./features/admin/MessagesPage'));
const NewsAdminPage = lazy(() => import('./features/admin/NewsAdminPage'));
const KnowledgeCenterPage = lazy(() => import('./features/admin/KnowledgeCenterPage'));
const ReportIssuePage = lazy(() => import('./features/support/ReportIssuePage'));
const MyReportsPage = lazy(() => import('./features/support/MyReportsPage'));
const ReportThreadPage = lazy(() => import('./features/support/ReportThreadPage'));
const NotificationsPage = lazy(() => import('./features/notifications/NotificationsPage'));
const HelpPage = lazy(() => import('./features/help/HelpPage'));
const LegalPage = lazy(() => import('./features/legal/LegalPage'));

// Public website (signed-out home page and public pages): separate chunks, not loaded by the app.
const SiteLayout = lazy(() => import('./features/site/layout/SiteLayout'));
const SiteHome = lazy(() => import('./features/site/home/HomePage'));
const info = () => import('./features/site/pages/InfoPages');
const docs = () => import('./features/site/pages/DocsPages');
const blog = () => import('./features/site/pages/BlogPages');
const AboutPage = lazy(() => info().then((m) => ({ default: m.AboutPage })));
const FeaturesPage = lazy(() => info().then((m) => ({ default: m.FeaturesPage })));
const IntegrationsPage = lazy(() => info().then((m) => ({ default: m.IntegrationsPage })));
const TrustPage = lazy(() => info().then((m) => ({ default: m.TrustPage })));
const ContactPage = lazy(() => info().then((m) => ({ default: m.ContactPage })));
const StatusPage = lazy(() => info().then((m) => ({ default: m.StatusPage })));
const PricingPage = lazy(() => info().then((m) => ({ default: m.PricingPage })));
const ChangelogPage = lazy(() => info().then((m) => ({ default: m.ChangelogPage })));
const HelpCentrePage = lazy(() => info().then((m) => ({ default: m.HelpCentrePage })));
const PolicyPage = lazy(() => info().then((m) => ({ default: m.PolicyPage })));
const NotFoundPage = lazy(() => info().then((m) => ({ default: m.NotFoundPage })));
const DocsIndexPage = lazy(() => docs().then((m) => ({ default: m.DocsIndexPage })));
const DocArticlePage = lazy(() => docs().then((m) => ({ default: m.DocArticlePage })));
const BlogIndexPage = lazy(() => blog().then((m) => ({ default: m.BlogIndexPage })));
const BlogPostPage = lazy(() => blog().then((m) => ({ default: m.BlogPostPage })));

export function Splash() {
  return (
    <div className="flex h-full items-center justify-center">
      <LogoMark className="size-9 animate-pulse" />
    </div>
  );
}

/**
 * Central guard for every signed-in page. The server and the Firestore rules
 * enforce the same conditions on every request; this decides what to show.
 * Signed-out visitors go to /login without remembering the page: every new
 * sign-in starts on New Chat.
 */
function Protected({ children }: { children: ReactNode }) {
  const { access } = useAuth();
  if (access === 'loading') return <Splash />;
  if (access === 'signed-out') return <Navigate to="/login" replace />;
  if (access === 'phone') return <Navigate to="/verify-phone" replace />;
  if (access === 'unverified') return <Navigate to="/verify" replace />;
  if (access === 'consent') return <Navigate to="/consent" replace />;
  if (access === 'request' || access === 'pending' || access === 'rejected') return <Navigate to="/request-access" replace />;
  if (access === 'denied' || access === 'error' || access === 'suspended' || access === 'deleted') return <Navigate to="/denied" replace />;
  return <>{children}</>;
}

/** Administrator pages: verified administrators only (the server re-checks every admin request). */
function AdminOnly({ children }: { children: ReactNode }) {
  const { access, admin } = useAuth();
  if (access === 'loading') return <Splash />;
  if (access !== 'allowed' || !admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * "/" and the app pages: signed-out visitors on "/" get the public home page;
 * everyone else goes through Protected exactly as before (signed-out visitors
 * on any other app page are still sent to /login).
 */
function AppGate() {
  const { access } = useAuth();
  const { pathname } = useLocation();
  if (access === 'signed-out' && pathname === '/') {
    return (
      <SiteLayout>
        <SiteHome />
      </SiteLayout>
    );
  }
  return (
    <Protected>
      <AppShell />
    </Protected>
  );
}

/** Unknown addresses: a 404 page for visitors, the app home for signed-in users. */
function CatchAll() {
  const { access } = useAuth();
  if (access === 'loading') return <Splash />;
  if (access !== 'signed-out') return <Navigate to="/" replace />;
  return (
    <SiteLayout>
      <NotFoundPage />
    </SiteLayout>
  );
}

/** Inactivity timeout and cross-tab sign-out, for anyone signed in. */
function Session() {
  const { user } = useAuth();
  return user ? <SessionGuard /> : null;
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
  // While signing out, show only the splash until the page reloads on /login (see session.ts).
  const ending = useSyncExternalStore(subscribeSessionEnding, sessionEnding);
  if (ending) {
    return (
      <div className="app-frame">
        <Splash />
      </div>
    );
  }
  return (
    // The consent banner takes its own row below the app, so it never covers a button.
    <div className="app-frame grid grid-rows-[minmax(0,1fr)_auto]">
      <div className="relative min-h-0">
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
              <Route path="/consent" element={<AuthPages mode="consent" />} />
              <Route element={<SiteLayout />}>
                <Route path="/about" element={<AboutPage />} />
                <Route path="/features" element={<FeaturesPage />} />
                <Route path="/integrations" element={<IntegrationsPage />} />
                <Route path="/docs" element={<DocsIndexPage />} />
                <Route path="/docs/:slug" element={<DocArticlePage />} />
                <Route path="/blog" element={<BlogIndexPage />} />
                <Route path="/blog/:slug" element={<BlogPostPage />} />
                <Route path="/trust" element={<TrustPage />} />
                <Route path="/security" element={<Navigate to="/trust#security" replace />} />
                <Route path="/accessibility" element={<PolicyPage slug="accessibility" />} />
                <Route path="/cookies" element={<PolicyPage slug="cookies" />} />
                <Route path="/acceptable-use" element={<PolicyPage slug="acceptable-use" />} />
                <Route path="/ai-transparency" element={<PolicyPage slug="ai-transparency" />} />
                <Route path="/privacy" element={<LegalPage doc="privacy" />} />
                <Route path="/terms" element={<LegalPage doc="terms" />} />
                <Route path="/contact" element={<ContactPage />} />
                <Route path="/help-centre" element={<HelpCentrePage />} />
                <Route path="/changelog" element={<ChangelogPage />} />
                <Route path="/status" element={<StatusPage />} />
                <Route path="/pricing" element={<PricingPage />} />
              </Route>
              <Route element={<AppGate />}>
                <Route index element={<ChatPage />} />
                <Route path="c/:conversationId" element={<ChatPage />} />
                <Route path="memory" element={<MemoryPage />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="projects/:projectId" element={<ProjectPage />} />
                <Route path="saved" element={<SavedPage />} />
                <Route path="images" element={<ImagesPage />} />
                <Route path="documents" element={<DocumentsPage />} />
                <Route path="knowledge" element={<KnowledgePage />} />
                <Route path="settings/:section?" element={<SettingsPage />} />
                <Route path="admin/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
                <Route path="admin/requests" element={<AdminOnly><AccessRequestsPage /></AdminOnly>} />
                <Route path="admin/support" element={<AdminOnly><SupportAdminPage /></AdminOnly>} />
                <Route path="admin/support/:ref" element={<AdminOnly><SupportReportAdminPage /></AdminOnly>} />
                <Route path="admin/sms" element={<AdminOnly><SmsAdminPage /></AdminOnly>} />
                <Route path="admin/email" element={<AdminOnly><EmailAdminPage /></AdminOnly>} />
                <Route path="admin/messages" element={<AdminOnly><MessagesPage /></AdminOnly>} />
                <Route path="admin/news" element={<AdminOnly><NewsAdminPage /></AdminOnly>} />
                {/* roles are checked by the server: platform admins and knowledge administrators */}
                <Route path="admin/knowledge-center" element={<KnowledgeCenterPage />} />
                <Route path="admin/*" element={<Navigate to="/" replace />} />
                <Route path="support" element={<MyReportsPage />} />
                <Route path="support/new" element={<ReportIssuePage />} />
                <Route path="support/:ref" element={<ReportThreadPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="help" element={<HelpPage />} />
                <Route path="help/:id" element={<HelpPage />} />
              </Route>
              <Route path="*" element={<CatchAll />} />
            </Routes>
            <Session />
          </Suspense>
        </ErrorBoundary>
      </div>
      <AnalyticsConsentBanner />
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

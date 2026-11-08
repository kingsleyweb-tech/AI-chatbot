import { lazy, Suspense, type ReactNode } from 'react';
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
  if (access === 'denied' || access === 'error') return <Navigate to="/denied" replace />;
  return <>{children}</>;
}

function Routed() {
  useVisualViewport();
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

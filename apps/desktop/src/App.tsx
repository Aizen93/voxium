import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { InvitePage } from './pages/InvitePage';
import { MainLayout } from './components/layout/MainLayout';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { ToastContainer } from './components/layout/ToastContainer';

const PENDING_REDIRECT_KEY = 'voxium_pending_redirect';

/** Redirects to the pending invite path (if any) or "/" after login. */
function AuthRedirect() {
  const [target] = useState(() => {
    const path = localStorage.getItem(PENDING_REDIRECT_KEY);
    if (path) localStorage.removeItem(PENDING_REDIRECT_KEY);
    return path || '/';
  });
  return <Navigate to={target} replace />;
}

/** Saves the current path before redirecting unauthenticated users to /login. */
function SaveAndRedirect() {
  const location = useLocation();
  localStorage.setItem(PENDING_REDIRECT_KEY, location.pathname);
  return <Navigate to="/login" replace />;
}

export function App() {
  const { isAuthenticated, checkAuth, isLoading } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-vox-bg-primary">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-vox-accent-primary border-t-transparent" />
          <p className="text-vox-text-secondary">Loading Voxium...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <ErrorBoundary>
        <Routes>
          <Route
            path="/login"
            element={isAuthenticated ? <AuthRedirect /> : <LoginPage />}
          />
          <Route
            path="/register"
            element={isAuthenticated ? <AuthRedirect /> : <RegisterPage />}
          />
          <Route
            path="/invite/:code"
            element={isAuthenticated ? <InvitePage /> : <SaveAndRedirect />}
          />
          <Route
            path="/*"
            element={isAuthenticated ? <MainLayout /> : <Navigate to="/login" replace />}
          />
        </Routes>
      </ErrorBoundary>
      <ToastContainer />
    </>
  );
}

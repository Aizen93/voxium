import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { InvitePage } from './pages/InvitePage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { EmailVerificationPendingPage } from './pages/EmailVerificationPendingPage';
import { LandingPage } from './pages/LandingPage';
import { TermsPage } from './pages/TermsPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { CookiePolicyPage } from './pages/CookiePolicyPage';
import { MainLayout } from './components/layout/MainLayout';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { ToastContainer } from './components/layout/ToastContainer';
import { UpdateChecker } from './components/updater/UpdateChecker';
import { TitleBar } from './components/layout/TitleBar';

const isTauri = '__TAURI_INTERNALS__' in window;

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
  useEffect(() => {
    localStorage.setItem(PENDING_REDIRECT_KEY, location.pathname);
  }, [location.pathname]);
  return <Navigate to="/login" replace />;
}

export function App({ onReady }: { onReady?: () => void }) {
  const { isAuthenticated, checkAuth, isLoading, user } = useAuthStore();
  const emailVerified = user?.emailVerified ?? false;

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Remove splash screen once auth check completes
  useEffect(() => {
    if (!isLoading && onReady) {
      onReady();
    }
  }, [isLoading, onReady]);

  if (isLoading) {
    // Show title bar during loading so the frameless window can still be moved/closed
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-vox-bg-primary">
        <TitleBar />
        <div className="flex-1" />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="flex-1 overflow-hidden">
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
            path="/forgot-password"
            element={isAuthenticated ? <AuthRedirect /> : <ForgotPasswordPage />}
          />
          <Route
            path="/reset-password/:token"
            element={isAuthenticated ? <AuthRedirect /> : <ResetPasswordPage />}
          />
          <Route
            path="/invite/:code"
            element={
              isAuthenticated
                ? emailVerified
                  ? <InvitePage />
                  : <EmailVerificationPendingPage />
                : <SaveAndRedirect />
            }
          />
          <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/cookies" element={<CookiePolicyPage />} />
          <Route
            path="/"
            element={
              isAuthenticated
                ? emailVerified
                  ? <MainLayout />
                  : <EmailVerificationPendingPage />
                : isTauri
                  ? <Navigate to="/login" replace />
                  : <LandingPage />
            }
          />
          <Route
            path="/*"
            element={
              isAuthenticated
                ? emailVerified
                  ? <MainLayout />
                  : <EmailVerificationPendingPage />
                : <Navigate to="/login" replace />
            }
          />
        </Routes>
      </ErrorBoundary>
      </div>
      <ToastContainer />
      <UpdateChecker />
    </div>
  );
}

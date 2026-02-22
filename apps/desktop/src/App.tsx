import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { MainLayout } from './components/layout/MainLayout';
import { ErrorBoundary } from './components/layout/ErrorBoundary';

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
    <ErrorBoundary>
      <Routes>
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
        />
        <Route
          path="/register"
          element={isAuthenticated ? <Navigate to="/" replace /> : <RegisterPage />}
        />
        <Route
          path="/*"
          element={isAuthenticated ? <MainLayout /> : <Navigate to="/login" replace />}
        />
      </Routes>
    </ErrorBoundary>
  );
}

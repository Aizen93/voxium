import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { AdminLoginPage } from './pages/AdminLoginPage';
import { AdminGuard } from './components/AdminGuard';
import { AdminLayout } from './components/AdminLayout';
import { ToastContainer } from './components/ToastContainer';

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
          <p className="text-vox-text-secondary">Loading Admin Panel...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/" replace /> : <AdminLoginPage />}
        />
        <Route
          path="/"
          element={
            isAuthenticated
              ? <AdminGuard><AdminLayout /></AdminGuard>
              : <Navigate to="/login" replace />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastContainer />
    </>
  );
}

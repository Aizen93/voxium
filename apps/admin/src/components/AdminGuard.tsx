import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);

  if (!user || user.role !== 'superadmin') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

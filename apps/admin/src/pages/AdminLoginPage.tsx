import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';

export function AdminLoginPage() {
  const { login, isSubmitting, error, clearError } = useAuthStore();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      navigate('/');
    } catch {
      // error is set in store
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary">
      <div className="w-full max-w-sm rounded-xl bg-vox-bg-secondary p-8 shadow-2xl border border-vox-border">
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-vox-accent-primary/20 text-vox-accent-primary">
            <Shield size={24} />
          </div>
          <h1 className="text-xl font-bold text-vox-text-primary">Voxium Admin</h1>
          <p className="text-sm text-vox-text-muted">Super admin access only</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-vox-accent-danger/10 border border-vox-accent-danger/30 px-3 py-2 text-sm text-vox-accent-danger">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-vox-text-secondary mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearError(); }}
              className="input"
              placeholder="admin@example.com"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-vox-text-secondary mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearError(); }}
              className="input"
              placeholder="Password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn-primary w-full"
          >
            {isSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

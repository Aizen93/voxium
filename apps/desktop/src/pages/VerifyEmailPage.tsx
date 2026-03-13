import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { CheckCircle, AlertCircle } from 'lucide-react';

// Module-scope: survives React StrictMode unmount/remount cycles
const processedTokens = new Set<string>();

export function VerifyEmailPage() {
  const { token } = useParams<{ token: string }>();
  const { user, checkAuth } = useAuthStore();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setError('Missing verification token.');
      return;
    }
    if (processedTokens.has(token)) return;
    processedTokens.add(token);

    api.post('/auth/verify-email', { token })
      .then(() => {
        setStatus('success');
        // Refresh auth state so the app knows email is now verified
        checkAuth();
      })
      .catch((err) => {
        // Allow retry on transient/network errors (keep in set only for server rejections)
        if (!err.response) processedTokens.delete(token);
        setStatus('error');
        setError(err.response?.data?.error || 'Verification failed. The link may be invalid or expired.');
      });
  }, [token]); // intentionally omit user/checkAuth — only re-run when token changes

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary">
      <div className="w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary p-8 shadow-2xl">
          <div className="mb-6 flex flex-col items-center">
            <img src="/logo.svg" alt="Voxium" className="h-16 w-16 rounded-2xl shadow-lg shadow-vox-accent-primary/20" />
            <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">Email Verification</h1>
          </div>

          {status === 'loading' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-vox-accent-primary border-t-transparent" />
              <p className="text-sm text-vox-text-secondary">Verifying your email...</p>
            </div>
          )}

          {status === 'success' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg bg-vox-voice-connected/10 border border-vox-voice-connected/20 px-4 py-3">
                <CheckCircle size={20} className="shrink-0 text-vox-voice-connected" />
                <p className="text-sm text-vox-voice-connected">Your email has been verified successfully!</p>
              </div>
              <Link to={user ? '/' : '/login'} className="btn-primary block w-full py-2.5 text-center">
                {user ? 'Continue to Voxium' : 'Go to Login'}
              </Link>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3">
                <AlertCircle size={20} className="shrink-0 text-vox-accent-danger" />
                <p className="text-sm text-vox-accent-danger">{error}</p>
              </div>
              <Link to={user ? '/' : '/login'} className="btn-primary block w-full py-2.5 text-center">
                {user ? 'Go Back' : 'Go to Login'}
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

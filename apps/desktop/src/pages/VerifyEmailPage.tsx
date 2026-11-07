import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { CheckCircle, AlertCircle } from 'lucide-react';
import { translateServerError } from '../utils/serverErrors';

// Module-scope: survives React StrictMode unmount/remount cycles, and a
// double click never posts the same token twice
const processedTokens = new Set<string>();

/** @internal tests */
export function _resetProcessedTokensForTests(): void {
  processedTokens.clear();
}

/**
 * The legacy verification link (accounts created before sign-up codes). It
 * NEVER posts on load: mail security gateways open the links in incoming
 * mail to scan them, and a scanner's visit would verify the address for
 * whoever typed it. A person clicks the button; a scanner does not.
 */
export function VerifyEmailPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const { user, checkAuth } = useAuthStore();
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(token ? 'idle' : 'error');
  const [error, setError] = useState<string | null>(token ? null : t('auth.verifyEmail.missingToken'));

  const handleVerify = () => {
    if (!token) return;
    if (processedTokens.has(token)) return;
    processedTokens.add(token);
    setStatus('loading');
    setError(null);

    api.post('/auth/verify-email', { token })
      .then(() => {
        setStatus('success');
        // Refresh auth state so the app knows email is now verified
        checkAuth();
      })
      .catch((err) => {
        const message = translateServerError(err?.response?.data?.error, t, 'auth.verifyEmail.failed');
        setError(message);
        if (!err?.response) {
          // Transient (no answer): the token was never judged, so the button
          // comes back for another try (kept in the set only for server rejections)
          console.warn('[VerifyEmail] Verification request failed without an answer:', err instanceof Error ? err.message : err);
          processedTokens.delete(token);
          setStatus('idle');
          return;
        }
        setStatus('error');
      });
  };

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary">
      <div className="w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary p-8 shadow-2xl">
          <div className="mb-6 flex flex-col items-center">
            <img src="/logo.svg" alt="Voxium" className="h-16 w-16 rounded-2xl shadow-lg shadow-vox-accent-primary/20" />
            <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">{t('auth.verifyEmail.title')}</h1>
          </div>

          {status === 'idle' && (
            <div className="space-y-4">
              <p className="text-center text-sm text-vox-text-secondary">{t('auth.verifyEmail.prompt')}</p>
              {error && (
                <div className="flex items-center gap-3 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3">
                  <AlertCircle size={20} className="shrink-0 text-vox-accent-danger" />
                  <p className="text-sm text-vox-accent-danger">{error}</p>
                </div>
              )}
              <button type="button" onClick={handleVerify} className="btn-primary block w-full py-2.5">
                {t('auth.verifyEmail.verifyButton')}
              </button>
            </div>
          )}

          {status === 'loading' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-vox-accent-primary border-t-transparent" />
              <p className="text-sm text-vox-text-secondary">{t('auth.verifyEmail.verifying')}</p>
            </div>
          )}

          {status === 'success' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg bg-vox-voice-connected/10 border border-vox-voice-connected/20 px-4 py-3">
                <CheckCircle size={20} className="shrink-0 text-vox-voice-connected" />
                <p className="text-sm text-vox-voice-connected">{t('auth.verifyEmail.success')}</p>
              </div>
              <Link to={user ? '/' : '/login'} className="btn-primary block w-full py-2.5 text-center">
                {user ? t('auth.verifyEmail.continueToVoxium') : t('auth.verifyEmail.goToLogin')}
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
                {user ? t('auth.verifyEmail.goBack') : t('auth.verifyEmail.goToLogin')}
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

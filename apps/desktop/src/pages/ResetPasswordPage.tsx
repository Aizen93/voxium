import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';
import { Eye, EyeOff } from 'lucide-react';
import { LIMITS } from '@voxium/shared';
import axios from 'axios';

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const { resetPassword } = useAuthStore();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t('auth.resetPassword.passwordsDoNotMatch'));
      return;
    }

    if (password.length < LIMITS.PASSWORD_MIN) {
      setError(t('auth.resetPassword.passwordMinLength', { min: LIMITS.PASSWORD_MIN }));
      return;
    }

    setIsLoading(true);
    try {
      await resetPassword(token!, password);
      setSuccess(true);
    } catch (err) {
      setError(axios.isAxiosError(err) ? err.response?.data?.error || t('auth.resetPassword.failedToReset') : t('auth.resetPassword.failedToReset'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary">
      <div className="w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary p-8 shadow-2xl">
          {/* Logo */}
          <div className="mb-8 flex flex-col items-center">
            <img src="/logo.svg" alt="Voxium" className="h-16 w-16 rounded-2xl shadow-lg shadow-vox-accent-primary/20" />
            <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">{t('auth.resetPassword.title')}</h1>
            <p className="mt-1 text-center text-vox-text-secondary">
              {t('auth.resetPassword.subtitle')}
            </p>
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger">
              {error}
            </div>
          )}

          {success ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-vox-voice-connected/10 border border-vox-voice-connected/20 px-4 py-3 text-sm text-vox-voice-connected">
                {t('auth.resetPassword.successMessage')}
              </div>
              <Link to="/login" className="btn-primary block w-full py-2.5 text-center">
                {t('auth.resetPassword.goToLogin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                  {t('auth.resetPassword.newPassword')}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="input pr-10"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(null); }}
                    placeholder={t('auth.resetPassword.newPasswordPlaceholder')}
                    required
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-vox-text-muted hover:text-vox-text-secondary"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                  {t('auth.resetPassword.confirmPassword')}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="input pr-10"
                    value={confirmPassword}
                    onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
                    placeholder={t('auth.resetPassword.confirmPasswordPlaceholder')}
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="btn-primary w-full py-2.5"
              >
                {isLoading ? t('auth.resetPassword.resetting') : t('auth.resetPassword.resetPassword')}
              </button>
            </form>
          )}

          {!success && (
            <p className="mt-6 text-center text-sm text-vox-text-secondary">
              <Link to="/login" className="text-vox-text-link hover:underline">
                {t('auth.resetPassword.backToLogin')}
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

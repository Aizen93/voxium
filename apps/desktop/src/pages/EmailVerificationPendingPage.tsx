import { useState, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';
import { Mail, RotateCw, LogOut } from 'lucide-react';
import axios from 'axios';

export function EmailVerificationPendingPage() {
  const { t } = useTranslation();
  const { user, logout, resendVerification } = useAuthStore();
  const [isSending, setIsSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const startCooldown = (seconds: number) => {
    setCooldown(seconds);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleResend = async () => {
    setIsSending(true);
    setError(null);
    setMessage(null);
    try {
      await resendVerification();
      setMessage(t('auth.emailPending.sent'));
      startCooldown(60);
    } catch (err) {
      const retryAfter = axios.isAxiosError(err) ? Math.min(parseInt(err.response?.headers?.['retry-after'], 10) || 0, 300) : 0;
      if (retryAfter > 0) {
        startCooldown(retryAfter);
      }
      setError(axios.isAxiosError(err) ? err.response?.data?.error || t('auth.emailPending.failedToSend') : t('auth.emailPending.failedToSend'));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary">
      <div className="w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary p-8 shadow-2xl">
          <div className="mb-6 flex flex-col items-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-vox-accent-primary/10">
              <Mail size={32} className="text-vox-accent-primary" />
            </div>
            <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">{t('auth.emailPending.title')}</h1>
            <p className="mt-2 text-center text-sm text-vox-text-secondary">
              <Trans i18nKey="auth.emailPending.description" values={{ email: user?.email }}>
                We sent a verification link to <span className="font-medium text-vox-text-primary">{'{{email}}'}</span>. Check your inbox and click the link to activate your account.
              </Trans>
            </p>
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger">
              {error}
            </div>
          )}

          {message && (
            <div className="mb-4 rounded-lg bg-vox-voice-connected/10 border border-vox-voice-connected/20 px-4 py-3 text-sm text-vox-voice-connected">
              {message}
            </div>
          )}

          <div className="space-y-3">
            <button
              onClick={handleResend}
              disabled={isSending || cooldown > 0}
              className="btn-primary flex w-full items-center justify-center gap-2 py-2.5"
            >
              <RotateCw size={16} className={isSending ? 'animate-spin' : ''} />
              {cooldown > 0
                ? t('auth.emailPending.resendIn', { seconds: cooldown })
                : isSending
                  ? t('auth.emailPending.sending')
                  : t('auth.emailPending.resend')}
            </button>

            <button
              onClick={logout}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-vox-border py-2.5 text-sm text-vox-text-secondary hover:bg-vox-bg-tertiary hover:text-vox-text-primary transition-colors"
            >
              <LogOut size={16} />
              {t('common.logout')}
            </button>
          </div>

          <p className="mt-6 text-center text-xs text-vox-text-muted">
            {t('auth.emailPending.checkSpam')}
          </p>
        </div>
      </div>
    </div>
  );
}

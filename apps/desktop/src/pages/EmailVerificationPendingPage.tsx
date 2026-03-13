import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Mail, RotateCw, LogOut } from 'lucide-react';

export function EmailVerificationPendingPage() {
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

  const handleResend = async () => {
    setIsSending(true);
    setError(null);
    setMessage(null);
    try {
      await resendVerification();
      setMessage('Verification email sent! Check your inbox.');
      setCooldown(60);
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
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to send verification email.');
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
            <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">Verify your email</h1>
            <p className="mt-2 text-center text-sm text-vox-text-secondary">
              We sent a verification link to{' '}
              <span className="font-medium text-vox-text-primary">{user?.email}</span>.
              Check your inbox and click the link to activate your account.
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
                ? `Resend in ${cooldown}s`
                : isSending
                  ? 'Sending...'
                  : 'Resend verification email'}
            </button>

            <button
              onClick={logout}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-vox-border py-2.5 text-sm text-vox-text-secondary hover:bg-vox-bg-tertiary hover:text-vox-text-primary transition-colors"
            >
              <LogOut size={16} />
              Log out
            </button>
          </div>

          <p className="mt-6 text-center text-xs text-vox-text-muted">
            Didn't receive the email? Check your spam folder or try resending.
          </p>
        </div>
      </div>
    </div>
  );
}

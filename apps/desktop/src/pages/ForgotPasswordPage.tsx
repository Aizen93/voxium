import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

export function ForgotPasswordPage() {
  const { forgotPassword } = useAuthStore();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await forgotPassword(email);
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
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
            <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">Forgot Password</h1>
            <p className="mt-1 text-center text-vox-text-secondary">
              Enter your email and we'll send you a link to reset your password.
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
                If an account with that email exists, a reset link has been sent. Check your inbox.
              </div>
              <Link to="/login" className="btn-primary block w-full py-2.5 text-center">
                Back to Login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                  Email
                </label>
                <input
                  type="email"
                  className="input"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(null); }}
                  placeholder="you@example.com"
                  required
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="btn-primary w-full py-2.5"
              >
                {isLoading ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>
          )}

          {!success && (
            <p className="mt-6 text-center text-sm text-vox-text-secondary">
              Remember your password?{' '}
              <Link to="/login" className="text-vox-text-link hover:underline">
                Sign in
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useRef, useCallback, useEffect, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Eye, EyeOff, ShieldCheck, ArrowLeft } from 'lucide-react';
import { AuthBackground } from '../components/auth/AuthBackground';
import { PeekingThief } from '../components/auth/PeekingThief';

export function LoginPage() {
  const { login, verifyTOTP, cancelTOTP, totpRequired, error, clearError, isSubmitting } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // Thief watching state
  const [isPasswordFocused, setIsPasswordFocused] = useState(false);
  const [isTypingPassword, setIsTypingPassword] = useState(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handlePasswordChange = useCallback((value: string) => {
    setPassword(value);
    clearError();
    setIsTypingPassword(true);
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => setIsTypingPassword(false), 1500);
  }, [clearError]);

  useEffect(() => {
    return () => clearTimeout(typingTimeoutRef.current);
  }, []);

  const isWatching = isPasswordFocused && isTypingPassword;

  // TOTP state
  const [totpCode, setTotpCode] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password, rememberMe);
    } catch {
      // Error is handled in the store
    }
  };

  const handleTotpSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await verifyTOTP(totpCode);
    } catch {
      // Error is handled in the store
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center bg-vox-bg-primary overflow-hidden">
      {/* Shake keyframe for error banner */}
      <style>{`
        @keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
        .animate-shake{animation:shake 0.4s ease-in-out}
      `}</style>

      <AuthBackground />

      <div className="relative z-10 w-full max-w-md px-4 pt-14">
        <div className="relative">
          <PeekingThief isWatching={isWatching} />
          <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary/80 backdrop-blur-sm p-8 shadow-2xl">
          {totpRequired ? (
            /* ─── TOTP Verification Step ─── */
            <>
              <div className="mb-8 flex flex-col items-center animate-fade-in">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-vox-accent-primary/20 shadow-lg shadow-vox-accent-primary/20">
                  <ShieldCheck size={32} className="text-vox-accent-primary" />
                </div>
                <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">Two-Factor Authentication</h1>
                <p className="mt-1 text-vox-text-secondary text-center">
                  Enter the 6-digit code from your authenticator app
                </p>
              </div>

              {error && (
                <div className="mb-4 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger animate-shake">
                  {error}
                </div>
              )}

              <form onSubmit={handleTotpSubmit} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                    Verification Code
                  </label>
                  <input
                    type="text"
                    autoComplete="one-time-code"
                    maxLength={8}
                    className="input text-center text-2xl tracking-[0.5em] font-mono transition-all duration-200 focus:shadow-[0_0_0_3px_rgba(91,91,247,0.15)]"
                    value={totpCode}
                    onChange={(e) => { setTotpCode(e.target.value.replace(/[^a-zA-Z0-9]/g, '')); clearError(); }}
                    placeholder="000000"
                    required
                    autoFocus
                  />
                  <p className="mt-2 text-[10px] text-vox-text-muted text-center">
                    You can also use a backup code
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting || totpCode.length < 6}
                  className="btn-primary w-full py-2.5 transition-all duration-150 active:scale-[0.98] hover:shadow-lg hover:shadow-vox-accent-primary/20"
                >
                  {isSubmitting ? 'Verifying...' : 'Verify'}
                </button>
              </form>

              <button
                onClick={() => { cancelTOTP(); setTotpCode(''); }}
                className="mt-4 flex items-center gap-1 text-sm text-vox-text-muted hover:text-vox-text-secondary transition-colors mx-auto"
              >
                <ArrowLeft size={14} />
                Back to login
              </button>
            </>
          ) : (
            /* ─── Normal Login Form ─── */
            <>
          {/* Logo */}
          <div className="mb-8 flex flex-col items-center animate-fade-in">
            <img src="/logo.svg" alt="Voxium" className="h-16 w-16 rounded-2xl shadow-lg shadow-vox-accent-primary/20" />
            <h1
              className="mt-4 text-2xl font-bold text-vox-text-primary animate-slide-up"
              style={{ animationDelay: '0.1s', animationFillMode: 'backwards' }}
            >
              Welcome back!
            </h1>
            <p
              className="mt-1 text-vox-text-secondary animate-slide-up"
              style={{ animationDelay: '0.15s', animationFillMode: 'backwards' }}
            >
              Sign in to continue to Voxium
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger animate-shake">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div
              className="animate-slide-up"
              style={{ animationDelay: '0.2s', animationFillMode: 'backwards' }}
            >
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                Email
              </label>
              <input
                type="email"
                className="input transition-all duration-200 focus:shadow-[0_0_0_3px_rgba(91,91,247,0.15)]"
                value={email}
                onChange={(e) => { setEmail(e.target.value); clearError(); }}
                placeholder="you@example.com"
                required
                autoFocus
              />
            </div>

            <div
              className="animate-slide-up"
              style={{ animationDelay: '0.25s', animationFillMode: 'backwards' }}
            >
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="input pr-10 transition-all duration-200 focus:shadow-[0_0_0_3px_rgba(91,91,247,0.15)]"
                  value={password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
                  onFocus={() => setIsPasswordFocused(true)}
                  onBlur={() => setIsPasswordFocused(false)}
                  placeholder="Your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-vox-text-muted hover:text-vox-text-secondary transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <div
              className="flex items-center justify-between animate-slide-up"
              style={{ animationDelay: '0.3s', animationFillMode: 'backwards' }}
            >
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-vox-border bg-vox-bg-tertiary accent-vox-accent-primary"
                />
                <span className="text-xs text-vox-text-secondary">Remember me</span>
              </label>
              <Link to="/forgot-password" className="text-xs text-vox-text-link hover:underline">
                Forgot password?
              </Link>
            </div>

            <div
              className="animate-slide-up"
              style={{ animationDelay: '0.35s', animationFillMode: 'backwards' }}
            >
              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary w-full py-2.5 transition-all duration-150 active:scale-[0.98] hover:shadow-lg hover:shadow-vox-accent-primary/20"
              >
                {isSubmitting ? 'Signing in...' : 'Sign In'}
              </button>
            </div>
          </form>

          <p
            className="mt-6 text-center text-sm text-vox-text-secondary animate-slide-up"
            style={{ animationDelay: '0.4s', animationFillMode: 'backwards' }}
          >
            Don't have an account?{' '}
            <Link to="/register" className="text-vox-text-link hover:underline">
              Create one
            </Link>
          </p>
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

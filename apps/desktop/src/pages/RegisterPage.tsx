import { useState, useMemo, useRef, useCallback, useEffect, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';
import { Eye, EyeOff } from 'lucide-react';
import { AuthBackground } from '../components/auth/AuthBackground';
import { PeekingThief } from '../components/auth/PeekingThief';

function getPasswordStrength(pw: string): { level: 'weak' | 'medium' | 'strong'; percent: number; color: string } {
  if (pw.length === 0) return { level: 'weak', percent: 0, color: '#ed4245' };
  if (pw.length < 8) return { level: 'weak', percent: 25, color: '#ed4245' };

  const hasUpper = /[A-Z]/.test(pw);
  const hasLower = /[a-z]/.test(pw);
  const hasDigit = /\d/.test(pw);
  const hasSpecial = /[^A-Za-z0-9]/.test(pw);
  const variety = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;

  if (pw.length >= 12 && variety >= 3) return { level: 'strong', percent: 100, color: '#3eba68' };
  if (pw.length >= 8 && variety >= 2) return { level: 'medium', percent: 60, color: '#f5a623' };
  return { level: 'weak', percent: 25, color: '#ed4245' };
}

export function RegisterPage() {
  const { t } = useTranslation();
  const { register, error, clearError, isSubmitting } = useAuthStore();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

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

  const strength = useMemo(() => getPasswordStrength(password), [password]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await register(username, email, password);
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
          {/* Logo */}
          <div className="mb-8 flex flex-col items-center animate-fade-in">
            <img src="/logo.svg" alt="Voxium" className="h-16 w-16 rounded-2xl shadow-lg shadow-vox-accent-primary/20" />
            <h1
              className="mt-4 text-2xl font-bold text-vox-text-primary animate-slide-up"
              style={{ animationDelay: '0.1s', animationFillMode: 'backwards' }}
            >
              {t('auth.register.title')}
            </h1>
            <p
              className="mt-1 text-vox-text-secondary animate-slide-up"
              style={{ animationDelay: '0.15s', animationFillMode: 'backwards' }}
            >
              {t('auth.register.subtitle')}
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
                {t('auth.register.username')}
              </label>
              <input
                type="text"
                className="input transition-all duration-200 focus:shadow-[0_0_0_3px_rgba(91,91,247,0.15)]"
                value={username}
                onChange={(e) => { setUsername(e.target.value); clearError(); }}
                placeholder={t('auth.register.usernamePlaceholder')}
                required
                autoFocus
              />
            </div>

            <div
              className="animate-slide-up"
              style={{ animationDelay: '0.25s', animationFillMode: 'backwards' }}
            >
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                {t('auth.register.email')}
              </label>
              <input
                type="email"
                className="input transition-all duration-200 focus:shadow-[0_0_0_3px_rgba(91,91,247,0.15)]"
                value={email}
                onChange={(e) => { setEmail(e.target.value); clearError(); }}
                placeholder={t('auth.register.emailPlaceholder')}
                required
              />
            </div>

            <div
              className="animate-slide-up"
              style={{ animationDelay: '0.3s', animationFillMode: 'backwards' }}
            >
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                {t('auth.register.password')}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="input pr-10 transition-all duration-200 focus:shadow-[0_0_0_3px_rgba(91,91,247,0.15)]"
                  value={password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
                  onFocus={() => setIsPasswordFocused(true)}
                  onBlur={() => setIsPasswordFocused(false)}
                  placeholder={t('auth.register.passwordPlaceholder')}
                  required
                  minLength={8}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-vox-text-muted hover:text-vox-text-secondary transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {/* Password strength indicator */}
              {password.length > 0 && (
                <div className="mt-2">
                  <div className="h-1.5 w-full rounded-full bg-vox-bg-floating overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${strength.percent}%`, backgroundColor: strength.color }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] transition-colors duration-300" style={{ color: strength.color }}>
                    {strength.level === 'weak' && t('auth.register.passwordWeak')}
                    {strength.level === 'medium' && t('auth.register.passwordMedium')}
                    {strength.level === 'strong' && t('auth.register.passwordStrong')}
                  </p>
                </div>
              )}
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
                {isSubmitting ? t('auth.register.creatingAccount') : t('auth.register.createAccount')}
              </button>
            </div>
          </form>

          <p
            className="mt-6 text-center text-sm text-vox-text-secondary animate-slide-up"
            style={{ animationDelay: '0.4s', animationFillMode: 'backwards' }}
          >
            {t('auth.register.hasAccount')}{' '}
            <Link to="/login" className="text-vox-text-link hover:underline">
              {t('auth.register.signIn')}
            </Link>
          </p>
          </div>
        </div>
      </div>
    </div>
  );
}

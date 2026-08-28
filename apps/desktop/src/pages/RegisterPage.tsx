import { useState, useMemo, useRef, useCallback, useEffect, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';
import { Eye, EyeOff } from 'lucide-react';
import { AuthBackground } from '../components/auth/AuthBackground';
import { PeekingThief } from '../components/auth/PeekingThief';
import { LegalDocModal, type LegalDoc } from '../components/legal/LegalDocModal';

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
  const { register, cancelRegistration, error, clearError, isRegistering, powProgress } = useAuthStore();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Consent is two SEPARATE, UNCHECKED boxes (CNIL/GDPR: no pre-ticked
  // consent, one decision per document), and the form cannot be submitted
  // without both. The server enforces the same rule and records when each was
  // accepted, so this is the user-facing half of a two-sided check.
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [openDoc, setOpenDoc] = useState<LegalDoc | null>(null);

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

  // Leaving this view abandons the registration. The proof-of-work solve runs
  // for tens of seconds under subnet pressure, and since it moved off the main
  // thread the user can navigate away mid-solve — without this it finishes in
  // the background, POSTs, and signs them into the account they walked away
  // from, on top of a worker still burning a core.
  useEffect(() => cancelRegistration, [cancelRegistration]);

  const isWatching = isPasswordFocused && isTypingPassword;

  const strength = useMemo(() => getPasswordStrength(password), [password]);

  const consented = acceptTerms && acceptPrivacy;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!consented) return;
    try {
      await register(username, email, password, { acceptTerms, acceptPrivacy });
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
              <label htmlFor="register-username" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                {t('auth.register.username')}
              </label>
              {/* autoComplete="nickname", NOT "username": the login identifier
                  is the email, so that is what password managers hold as the
                  saved username — and they pasted it into this field, leaving
                  the email field empty. A nickname is a handle, not a credential. */}
              <input
                id="register-username"
                name="nickname"
                type="text"
                autoComplete="nickname"
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
              <label htmlFor="register-email" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                {t('auth.register.email')}
              </label>
              <input
                id="register-email"
                name="email"
                type="email"
                autoComplete="email"
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
              <label htmlFor="register-password" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                {t('auth.register.password')}
              </label>
              <div className="relative">
                <input
                  id="register-password"
                  name="new-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
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
                  aria-label={showPassword ? t('auth.register.hidePassword') : t('auth.register.showPassword')}
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

            {/* Consent — two separate boxes, both unchecked by default, each
                naming the document it refers to. The documents open in a modal
                so the half-filled form is never navigated away from. */}
            <fieldset
              className="animate-slide-up space-y-2.5"
              style={{ animationDelay: '0.35s', animationFillMode: 'backwards' }}
              data-testid="register-consent"
            >
              <legend className="sr-only">{t('auth.register.consentLegend')}</legend>
              <label htmlFor="register-accept-terms" className="flex cursor-pointer items-start gap-2.5 text-sm text-vox-text-secondary">
                <input
                  id="register-accept-terms"
                  name="acceptTerms"
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-vox-border bg-vox-bg-secondary accent-vox-accent-primary"
                  required
                />
                <span>
                  {t('auth.register.acceptTermsPrefix')}{' '}
                  <button type="button" onClick={() => setOpenDoc('terms')} className="text-vox-text-link hover:underline">
                    {t('auth.register.termsOfService')}
                  </button>
                </span>
              </label>
              <label htmlFor="register-accept-privacy" className="flex cursor-pointer items-start gap-2.5 text-sm text-vox-text-secondary">
                <input
                  id="register-accept-privacy"
                  name="acceptPrivacy"
                  type="checkbox"
                  checked={acceptPrivacy}
                  onChange={(e) => setAcceptPrivacy(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-vox-border bg-vox-bg-secondary accent-vox-accent-primary"
                  required
                />
                <span>
                  {t('auth.register.acceptPrivacyPrefix')}{' '}
                  <button type="button" onClick={() => setOpenDoc('privacy')} className="text-vox-text-link hover:underline">
                    {t('auth.register.privacyPolicy')}
                  </button>
                </span>
              </label>
            </fieldset>

            <div
              className="animate-slide-up"
              style={{ animationDelay: '0.4s', animationFillMode: 'backwards' }}
            >
              <button
                type="submit"
                disabled={isRegistering || !consented}
                className="btn-primary w-full py-2.5 transition-all duration-150 active:scale-[0.98] hover:shadow-lg hover:shadow-vox-accent-primary/20"
              >
                {isRegistering ? t('auth.register.creatingAccount') : t('auth.register.createAccount')}
              </button>

              {/* Anti-bot proof-of-work. Only shown once it is slow enough to
                  need explaining — a sub-second solve on an unloaded subnet
                  would just flash a bar at the user for no reason. */}
              {powProgress !== null && powProgress > 0 && (
                <div className="mt-3" aria-live="polite">
                  <div className="h-1 w-full overflow-hidden rounded-full bg-vox-bg-tertiary">
                    <div
                      className="h-full rounded-full bg-vox-accent-primary transition-[width] duration-300"
                      style={{ width: `${Math.round(powProgress * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-center text-xs text-vox-text-secondary">
                    {t('auth.register.verifyingBrowser')}
                  </p>
                </div>
              )}
            </div>
          </form>

          <p
            className="mt-6 text-center text-sm text-vox-text-secondary animate-slide-up"
            style={{ animationDelay: '0.45s', animationFillMode: 'backwards' }}
          >
            {t('auth.register.hasAccount')}{' '}
            <Link to="/login" className="text-vox-text-link hover:underline">
              {t('auth.register.signIn')}
            </Link>
          </p>
          </div>
        </div>
      </div>

      {openDoc && <LegalDocModal doc={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

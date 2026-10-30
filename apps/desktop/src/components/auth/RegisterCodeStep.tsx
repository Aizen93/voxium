import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SIGNUP } from '@voxium/shared';
import { useAuthStore } from '../../stores/authStore';

/** `m:ss`, the resend countdown. */
function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Step two of the verify-first registration: the server answered 202 and
 * mailed a code (or, when the address already has an account, a notice — the
 * page cannot tell, and says so for both). The code creates the account and
 * signs the user in; a "username taken" answer asks for another name and the
 * SAME code goes again. One resend, after the server's delay.
 */
export function RegisterCodeStep() {
  const { t } = useTranslation();
  const pending = useAuthStore((s) => s.pendingRegistration);
  const isRegistering = useAuthStore((s) => s.isRegistering);
  const completeRegistration = useAuthStore((s) => s.completeRegistration);
  const resendRegistrationCode = useAuthStore((s) => s.resendRegistrationCode);
  const cancelRegistration = useAuthStore((s) => s.cancelRegistration);
  const clearError = useAuthStore((s) => s.clearError);

  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [resending, setResending] = useState(false);
  // "Start over" asks first: a new start mails a new code, and an address
  // receives only a few sign-up mails per window
  const [confirmingStartOver, setConfirmingStartOver] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const readyAt = pending ? pending.issuedAt + pending.resendAfterSeconds * 1000 : 0;
  const remaining = Math.max(0, readyAt - now);
  const counting = !!pending && !pending.resendUsed && remaining > 0;

  // Re-render once a second while the resend is still locked
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  if (!pending) return null;

  const needsUsername = pending.usernameTaken;
  const codeComplete = code.length === SIGNUP.CODE_LENGTH;
  const canSubmit = codeComplete && !isRegistering && (!needsUsername || username.trim().length > 0);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      await completeRegistration(code, needsUsername ? username.trim() : undefined);
    } catch {
      // The store holds the error; a taken username sets the flag that shows the field
    }
  };

  const handleResend = async () => {
    setResending(true);
    try {
      await resendRegistrationCode();
    } catch {
      // The store holds the error; the button stays for another try
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="register-code-step">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-vox-text-primary">{t('auth.register.code.title')}</h1>
        <p className="mt-2 text-sm text-vox-text-secondary break-words">
          {t('auth.register.code.sentTo', { email: pending.email, length: SIGNUP.CODE_LENGTH, minutes: SIGNUP.CODE_TTL_MINUTES })}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          id="register-code"
          name="one-time-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern={`[0-9]{${SIGNUP.CODE_LENGTH}}`}
          maxLength={SIGNUP.CODE_LENGTH}
          aria-label={t('auth.register.code.codeLabel')}
          placeholder={'0'.repeat(SIGNUP.CODE_LENGTH)}
          className="input text-center text-2xl font-mono tracking-[0.5em]"
          value={code}
          onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, SIGNUP.CODE_LENGTH)); clearError(); }}
          required
          autoFocus
        />

        {needsUsername && (
          <div>
            <label htmlFor="register-code-username" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
              {t('auth.register.code.usernameLabel')}
            </label>
            <input
              id="register-code-username"
              name="nickname"
              type="text"
              autoComplete="nickname"
              className="input"
              value={username}
              onChange={(e) => { setUsername(e.target.value); clearError(); }}
              placeholder={t('auth.register.usernamePlaceholder')}
              required
            />
            <p className="mt-1.5 text-xs text-vox-text-secondary">{t('auth.register.code.usernameTakenHint')}</p>
          </div>
        )}

        <button type="submit" disabled={!canSubmit} className="btn-primary w-full py-2.5">
          {t('auth.register.code.submit')}
        </button>
        {isRegistering && (
          <p className="text-center text-xs text-vox-text-secondary" aria-live="polite">{t('auth.register.code.verifying')}</p>
        )}
      </form>

      <div className="space-y-2 text-center text-sm text-vox-text-secondary">
        <p>{t('auth.register.code.spamHint')}</p>
        {pending.resendUsed ? (
          <p aria-live="polite">{t('auth.register.code.resent')}</p>
        ) : (
          <div>
            <button
              type="button"
              onClick={handleResend}
              disabled={counting || resending}
              className="text-vox-text-link hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
            >
              {t('auth.register.code.resend')}
            </button>
            {counting && (
              <p className="mt-1 text-xs" data-testid="register-code-countdown">
                {t('auth.register.code.resendIn', { time: formatRemaining(remaining) })}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-vox-border bg-vox-bg-tertiary/40 px-4 py-3 text-center text-sm text-vox-text-secondary">
        <p>{t('auth.register.code.haveAccount')}</p>
        <p className="mt-1.5">
          <Link to="/login" className="text-vox-text-link hover:underline">{t('auth.register.code.signIn')}</Link>
          <span aria-hidden="true"> · </span>
          <Link to="/forgot-password" className="text-vox-text-link hover:underline">{t('auth.register.code.resetPassword')}</Link>
        </p>
      </div>

      {confirmingStartOver ? (
        <div className="rounded-lg border border-vox-accent-warning/30 bg-vox-accent-warning/10 px-4 py-3 text-center text-sm" role="alert">
          <p className="text-vox-text-secondary">
            {t('auth.register.code.startOverWarning', { mails: SIGNUP.LEDGER_MAX_MAILS, days: SIGNUP.LEDGER_WINDOW_DAYS })}
          </p>
          <p className="mt-2 flex justify-center gap-4">
            <button type="button" onClick={cancelRegistration} className="text-vox-text-link hover:underline">
              {t('auth.register.code.startOverConfirm')}
            </button>
            <button type="button" onClick={() => setConfirmingStartOver(false)} className="text-vox-text-muted hover:text-vox-text-secondary hover:underline">
              {t('common.cancel')}
            </button>
          </p>
        </div>
      ) : (
        <p className="text-center text-sm">
          <button type="button" onClick={() => setConfirmingStartOver(true)} className="text-vox-text-muted hover:text-vox-text-secondary hover:underline">
            {t('auth.register.code.startOver')}
          </button>
        </p>
      )}
    </div>
  );
}

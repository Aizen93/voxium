import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText, LogOut } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { LegalDocModal, type LegalDoc } from '../components/legal/LegalDocModal';
import { getTranslatedError } from '../utils/serverErrors';

/**
 * Shown to an authenticated account that has not accepted the Terms of
 * Service and the Privacy Policy — accounts created before consent was
 * collected at signup (CNIL/GDPR). Nothing else is reachable until it is
 * given: every functional route and the socket refuse (`requireConsent`),
 * and the client never connects the socket for such an account. Same two
 * separate, unchecked boxes as the registration form, same documents in
 * the same modal; the only other way out is logging out.
 */
export function ConsentPage() {
  const { t } = useTranslation();
  const { acceptConsent, logout } = useAuthStore();
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [openDoc, setOpenDoc] = useState<LegalDoc | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const consented = acceptTerms && acceptPrivacy;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!consented || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await acceptConsent({ acceptTerms, acceptPrivacy });
    } catch (err) {
      setError(getTranslatedError(err, t, 'auth.consent.failed'));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary">
      <div className="w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary p-8 shadow-2xl">
          <div className="mb-6 flex flex-col items-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-vox-accent-primary/10">
              <ScrollText size={32} className="text-vox-accent-primary" />
            </div>
            <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">{t('auth.consent.title')}</h1>
            <p className="mt-2 text-center text-sm text-vox-text-secondary">{t('auth.consent.description')}</p>
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <fieldset className="space-y-2.5" data-testid="consent-gate">
              <legend className="sr-only">{t('auth.register.consentLegend')}</legend>
              <label htmlFor="consent-accept-terms" className="flex cursor-pointer items-start gap-2.5 text-sm text-vox-text-secondary">
                <input
                  id="consent-accept-terms"
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
              <label htmlFor="consent-accept-privacy" className="flex cursor-pointer items-start gap-2.5 text-sm text-vox-text-secondary">
                <input
                  id="consent-accept-privacy"
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

            <button
              type="submit"
              disabled={!consented || submitting}
              className="btn-primary w-full py-2.5"
            >
              {submitting ? t('auth.consent.submitting') : t('auth.consent.submit')}
            </button>

            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-vox-border py-2.5 text-sm text-vox-text-secondary hover:bg-vox-bg-tertiary hover:text-vox-text-primary transition-colors"
            >
              <LogOut size={16} />
              {t('common.logout')}
            </button>
          </form>
        </div>
      </div>

      {openDoc && <LegalDocModal doc={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

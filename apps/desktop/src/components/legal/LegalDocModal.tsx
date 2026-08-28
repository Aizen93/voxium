import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { TermsContent } from './TermsContent';
import { PrivacyContent } from './PrivacyContent';

export type LegalDoc = 'terms' | 'privacy';

interface Props {
  doc: LegalDoc;
  onClose: () => void;
}

/**
 * The Terms of Service / Privacy Policy shown from the registration form.
 *
 * A modal rather than a link to /terms: consent has to be given on the form,
 * and navigating away loses everything typed so far — and the Tauri webview
 * has no "new tab" to open the page in. Same document, same component, as the
 * public page (TermsContent / PrivacyContent), so the text a user accepts is
 * the text that is published.
 */
export function LegalDocModal({ doc, onClose }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-doc-title"
      data-testid={`legal-doc-${doc}`}
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-vox-border bg-vox-bg-secondary shadow-2xl animate-slide-up">
        <div className="flex items-center justify-between border-b border-vox-border px-6 py-4">
          <h2 id="legal-doc-title" className="text-base font-semibold text-vox-text-primary">
            {doc === 'terms' ? t('auth.register.termsOfService') : t('auth.register.privacyPolicy')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
            aria-label={t('common.close')}
          >
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-6 text-vox-text-primary">
          {doc === 'terms' ? <TermsContent /> : <PrivacyContent />}
        </div>
        <div className="border-t border-vox-border px-6 py-3 text-right">
          <button type="button" onClick={onClose} className="btn-primary px-4 py-2 text-sm">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

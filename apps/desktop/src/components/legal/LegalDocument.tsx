import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { isRTL } from '../../i18n/direction';
import { isEnglishLanguage, legalLanguageFor, type LegalLanguage } from './legalLanguage';

/**
 * One legal document in the app language when it is translated into it
 * (French), in English otherwise, as PrivacyContent, TermsContent and
 * CookiePolicyContent render it.
 *
 * The `lang` attribute makes a screen reader read the English text with an
 * English voice under <html lang="de">. In a language with no translation
 * (neither English nor French), a notice in that language says the document
 * exists in English and French and that the English is shown; the notice is
 * not part of the document files, so their structural comparison in
 * __tests__/legal/legalFacts.test.ts is unaffected.
 *
 * Under a right-to-left app language (Arabic) the English document is laid out
 * left to right while its notice keeps the app's right-to-left direction.
 */
export function LegalDocument({ documents }: { documents: Record<LegalLanguage, ComponentType> }) {
  const { t, i18n } = useTranslation();
  const appLanguage = i18n.resolvedLanguage ?? i18n.language;
  const lang = legalLanguageFor(appLanguage);
  const Document = documents[lang];
  const showNotice = lang === 'en' && !!appLanguage && !isEnglishLanguage(appLanguage);
  const appIsRtl = !!appLanguage && isRTL(appLanguage);
  return (
    <div lang={lang} dir={lang === 'en' && appIsRtl ? 'ltr' : undefined}>
      {showNotice && (
        <p
          className="mb-6 text-sm text-vox-text-muted"
          data-testid="legal-language-notice"
          lang={appLanguage}
          dir={appIsRtl ? 'rtl' : undefined}
        >
          {t('legal.englishVersionNotice')}
        </p>
      )}
      <Document />
    </div>
  );
}

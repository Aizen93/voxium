import type { ComponentType } from 'react';
import { useLegalLanguage, type LegalLanguage } from './legalLanguage';
import { TermsContentEn } from './TermsContent.en';
import { TermsContentFr } from './TermsContent.fr';

/**
 * The Terms of Service, in the app language when the document is translated
 * into it (French), in English otherwise. The text lives in
 * TermsContent.en.tsx and TermsContent.fr.tsx, both checked by
 * __tests__/legal/legalFacts.test.ts.
 */
export const TERMS_CONTENT: Record<LegalLanguage, ComponentType> = {
  en: TermsContentEn,
  fr: TermsContentFr,
};

export function TermsContent() {
  const lang = useLegalLanguage();
  const Document = TERMS_CONTENT[lang];
  // lang: under <html lang="de"> (or any app language without a translation)
  // the English text is still read with an English voice by screen readers
  return (
    <div lang={lang}>
      <Document />
    </div>
  );
}

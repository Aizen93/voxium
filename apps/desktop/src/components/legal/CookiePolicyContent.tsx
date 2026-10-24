import type { ComponentType } from 'react';
import { useLegalLanguage, type LegalLanguage } from './legalLanguage';
import { CookiePolicyContentEn } from './CookiePolicyContent.en';
import { CookiePolicyContentFr } from './CookiePolicyContent.fr';

/**
 * The Cookie Policy, in the app language when the document is translated into
 * it (French), in English otherwise. The text lives in
 * CookiePolicyContent.en.tsx and CookiePolicyContent.fr.tsx, both checked by
 * __tests__/legal/legalFacts.test.ts; the page chrome is
 * pages/CookiePolicyPage.tsx.
 */
export const COOKIE_POLICY_CONTENT: Record<LegalLanguage, ComponentType> = {
  en: CookiePolicyContentEn,
  fr: CookiePolicyContentFr,
};

export function CookiePolicyContent() {
  const lang = useLegalLanguage();
  const Document = COOKIE_POLICY_CONTENT[lang];
  // lang: under <html lang="de"> (or any app language without a translation)
  // the English text is still read with an English voice by screen readers
  return (
    <div lang={lang}>
      <Document />
    </div>
  );
}

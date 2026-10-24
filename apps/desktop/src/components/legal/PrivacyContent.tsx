import type { ComponentType } from 'react';
import { useLegalLanguage, type LegalLanguage } from './legalLanguage';
import { PrivacyContentEn } from './PrivacyContent.en';
import { PrivacyContentFr } from './PrivacyContent.fr';

/**
 * The Privacy Policy, in the app language when the document is translated
 * into it (French), in English otherwise. The text lives in
 * PrivacyContent.en.tsx and PrivacyContent.fr.tsx; their rules (every claim
 * matches the code, every number is pinned, no infrastructure names) are in
 * the English file and enforced on both by __tests__/legal/legalFacts.test.ts.
 */
export const PRIVACY_CONTENT: Record<LegalLanguage, ComponentType> = {
  en: PrivacyContentEn,
  fr: PrivacyContentFr,
};

export function PrivacyContent() {
  const lang = useLegalLanguage();
  const Document = PRIVACY_CONTENT[lang];
  // lang: under <html lang="de"> (or any app language without a translation)
  // the English text is still read with an English voice by screen readers
  return (
    <div lang={lang}>
      <Document />
    </div>
  );
}

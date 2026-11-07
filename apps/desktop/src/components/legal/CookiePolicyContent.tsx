import type { ComponentType } from 'react';
import type { LegalLanguage } from './legalLanguage';
import { LegalDocument } from './LegalDocument';
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
  return <LegalDocument documents={COOKIE_POLICY_CONTENT} />;
}

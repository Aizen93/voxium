import type { ComponentType } from 'react';
import type { LegalLanguage } from './legalLanguage';
import { LegalDocument } from './LegalDocument';
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
  return <LegalDocument documents={TERMS_CONTENT} />;
}

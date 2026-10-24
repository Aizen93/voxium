import type { ComponentType } from 'react';
import type { LegalLanguage } from './legalLanguage';
import { LegalDocument } from './LegalDocument';
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
  return <LegalDocument documents={PRIVACY_CONTENT} />;
}

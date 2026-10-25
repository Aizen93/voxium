/**
 * The languages the legal documents are written in. The app speaks eleven,
 * but the Terms, the Privacy Policy and the Cookie Policy are maintained as
 * documents, one file per language (components/legal/*.en.tsx, *.fr.tsx), not
 * as i18n keys: every other app language reads the English text, under a
 * notice saying so (LegalDocument.tsx, i18n key legal.englishVersionNotice).
 *
 * Adding a language here is a type error in each dispatcher (PrivacyContent,
 * TermsContent, CookiePolicyContent) until the document exists, and in
 * __tests__/legal/legalFacts.test.ts until its numbers are pinned.
 */
export const LEGAL_LANGUAGES = ['en', 'fr'] as const;
export type LegalLanguage = (typeof LEGAL_LANGUAGES)[number];

/** French for any French tag ("fr", "fr-FR", "fr-CA"), English for everything else. */
export function legalLanguageFor(language: string | undefined): LegalLanguage {
  return language && /^fr(?:[-_]|$)/i.test(language) ? 'fr' : 'en';
}

/** True for any English tag ("en", "en-GB"). */
export function isEnglishLanguage(language: string | undefined): boolean {
  return !!language && /^en(?:[-_]|$)/i.test(language);
}

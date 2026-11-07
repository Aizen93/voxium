/**
 * Which app languages are written right to left. Kept apart from i18n/index.ts
 * (which initialises i18next and touches the document on import) so that code
 * rendered outside the app, such as the legal documents' tests, can ask too;
 * index.ts re-exports isRTL, so there is one list.
 */
const RTL_LANGUAGES = new Set(['ar']);

export function isRTL(lang: string): boolean {
  return RTL_LANGUAGES.has(lang);
}

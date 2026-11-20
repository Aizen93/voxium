/**
 * Who publishes and operates Voxium, and the promises the legal documents
 * make about their own changes: one source for the Terms, the Privacy Policy
 * and the Cookie Policy, in English and in French.
 *
 * Fill `publisherName` and `publisherAddress` here and both documents, in both
 * languages, name the publisher ("operated by {name}, {address}") instead of
 * offering its legal notice on request. Never put a guessed name or address
 * here: users accept these documents at signup.
 *
 * The French text reads "depuis la {country}" and the Terms name French law
 * and French courts: a country that does not take "la", or a move abroad,
 * means editing those sentences too (TermsContent.*.tsx, PrivacyContent.*.tsx).
 */
export interface LegalOperator {
  /** Where the Service is published and operated from ("from France", "depuis la France"). */
  country: string;
  /** General contact, and where the publisher's legal notice is requested. */
  contactEmail: string;
  /** Privacy contact: data-protection questions and requests (no Data Protection Officer is designated). */
  privacyEmail: string;
  /** The publisher's legal name, or null while the legal notice is given on request. */
  publisherName: string | null;
  /** The publisher's postal address, or null while the legal notice is given on request. */
  publisherAddress: string | null;
  /** Minimum notice, in days, before a material change to the Terms or the Privacy Policy takes effect. */
  changeNoticeDays: number;
}

export const LEGAL_OPERATOR: LegalOperator = {
  country: 'France',
  contactEmail: 'contact@voxium.app',
  privacyEmail: 'dpo@voxium.app',
  publisherName: null,
  publisherAddress: null,
  changeNoticeDays: 14,
};

/**
 * The Privacy Policy's own dates, `YYYY-MM-DD`, read by both languages.
 *
 * Both are set in the release commit: `lastUpdated` is the release day (the
 * date printed as "Last updated"), `conversationsKeptFrom` is the release day
 * plus at least `LEGAL_OPERATOR.changeNoticeDays` (the day from which an
 * account deletion keeps the other person's conversation). `confirmedForVersion`
 * is then set to the released version: the test that compares it with
 * `APP_VERSION` fails after a version bump until both dates have been looked at
 * again. It is a literal on purpose, so that it goes stale with the version.
 *
 * Once `conversationsKeptFrom` has passed, this constant and its test go away
 * together with the transitional "Until … / From …" sentence of the policy.
 */
export const PRIVACY_POLICY_DATES = {
  lastUpdated: '2026-11-20',
  conversationsKeptFrom: '2026-12-04',
  confirmedForVersion: '2.1.1',
} as const;

/** The publisher's identity when both its name and its address are filled in, else null (legal notice on request). */
export function publisherOf(operator: LegalOperator): { name: string; address: string } | null {
  return operator.publisherName && operator.publisherAddress
    ? { name: operator.publisherName, address: operator.publisherAddress }
    : null;
}

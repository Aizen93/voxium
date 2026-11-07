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

/** The publisher's identity when both its name and its address are filled in, else null (legal notice on request). */
export function publisherOf(operator: LegalOperator): { name: string; address: string } | null {
  return operator.publisherName && operator.publisherAddress
    ? { name: operator.publisherName, address: operator.publisherAddress }
    : null;
}

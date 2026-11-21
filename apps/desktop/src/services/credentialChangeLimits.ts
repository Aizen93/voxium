/**
 * The bounds of a credential change (services/session.ts) that the Cookie
 * Policy quotes, in a module of their own with no imports: the legal pages
 * read them from here and pull no request code in. The renewal re-exports
 * them; nothing else defines them.
 */

/**
 * The deadline of a credential change's request: it bounds how long renewals
 * stay held. Longer than the server's own budget for the transaction (60 s,
 * plus 10 s to get a connection), so a slow commit is still answered.
 */
export const CREDENTIAL_CHANGE_TIMEOUT_MS = 75_000;

/**
 * How far ahead a credential change's mark in the shared storage says it may
 * still be answered (tokenStorage.markCredentialChange): its request's
 * deadline, plus the time to store its answer and remove the mark. Every tab
 * of the account in the browser build holds its renewals while the mark is
 * live, at most this long; a mark its tab never removed (the tab was closed
 * meanwhile) is removed by the first tab that reads it once this has passed.
 */
export const CREDENTIAL_CHANGE_MARK_MS = CREDENTIAL_CHANGE_TIMEOUT_MS + 5_000;

/** CREDENTIAL_CHANGE_MARK_MS in whole seconds (the Cookie Policy quotes it). */
export const CREDENTIAL_CHANGE_MARK_SECONDS = CREDENTIAL_CHANGE_MARK_MS / 1000;

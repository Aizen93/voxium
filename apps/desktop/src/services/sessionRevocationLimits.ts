/**
 * The bounds of the sign-out queue (services/sessionRevocation.ts) that the
 * Cookie Policy quotes, in a module of their own with no imports: the legal
 * pages read them from here and pull no request code in. The queue
 * re-exports them; nothing else defines them.
 */

/** How long a sign-out that has not reached the server is kept for another try (the Cookie Policy quotes it). */
export const SIGN_OUT_RETRY_MAX_AGE_MINUTES = 15;
export const SIGN_OUT_RETRY_MAX_AGE_MS = SIGN_OUT_RETRY_MAX_AGE_MINUTES * 60_000;

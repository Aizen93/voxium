/**
 * The one page-level navigation a session change asks for in a page load:
 * a reload onto the session the storage holds now
 * (tokenStorage.reloadAfterSessionChange) or the trip to the sign-in page
 * (session.goToLoginPage). Both claim it here, and the first one wins: a
 * reload asked for after `/login?reason=…` must not override it, nor a trip
 * to the sign-in page a pending reload. A later request for the sign-in page
 * may still add its reason to a trip already pending (session.ts keeps that).
 *
 * Its own module, free of imports, because the session storage and the
 * renewal both need it and neither may import the other's side of it.
 */

export type PageNavigation = 'reload' | 'login';

let pending: PageNavigation | null = null;

/** Claim the page's one navigation: false when one is pending already (it stands). */
export function claimPageNavigation(kind: PageNavigation): boolean {
  if (pending !== null) return false;
  pending = kind;
  return true;
}

/** The navigation this page load has asked for, if any. */
export function pendingPageNavigation(): PageNavigation | null {
  return pending;
}

/** @internal tests: a fresh page load (nothing asked for yet) */
export function _resetPageNavigationForTests(): void {
  pending = null;
}

// The end of an account's E2E session, as the rest of the app sees it.
//
// A module of its own, with no imports: callers that only need to recognise
// "the session ended under me" (the display layer, the voice key chain) must
// not pull in the service, and tests that mock the service keep this one real.

/**
 * Did this work stop because the session it belonged to ended? A dispose
 * (logout, account switch, account deletion) fails what was still running
 * with E2EServiceDisposedError, or E2EVaultClosedError from the vault. That
 * is an ending, not a fault: callers settle quietly instead of reporting it.
 * Matched by name, so a copy of either class from another module instance
 * still counts.
 */
export function isE2ESessionEnded(err: unknown): boolean {
  return err instanceof Error && (err.name === 'E2EServiceDisposedError' || err.name === 'E2EVaultClosedError');
}

let sessionUser: (() => string | null) | null = null;

/**
 * Who is signed in, as getE2EService asks it. authStore registers its user
 * here (it imports the E2E service, so the service cannot import it back);
 * `null` unregisters.
 */
export function registerE2ESessionUser(source: (() => string | null) | null): void {
  sessionUser = source;
}

/** The signed-in user's id, null when signed out, undefined when nothing registered a source. */
export function currentE2ESessionUser(): string | null | undefined {
  return sessionUser ? sessionUser() : undefined;
}

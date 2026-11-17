// An account deletion of this client, while it runs. The server ends the
// account's sessions while it deletes it: it sends `force:logout` to every
// socket of the account (the deleting client's included) BEFORE its
// transaction and again after the commit, and every other request of the
// account is refused from then on. Each of those ends in a page change to
// the login page (services/socket.ts, services/session.ts), and a page change
// that lands before the deletion's own clean-up has run leaves the account's
// vault, its key, its secure-channel pins and its trusted-device token on the
// device. Every path that leaves the page therefore waits here first.
//
// The wait erases nothing itself: the first `force:logout` comes before the
// transaction and proves nothing; only `authStore.deleteAccount`, on the
// server's successful answer, removes the local state. No imports: the auth
// store, the socket and the session module all depend on this one.

/** The longest a page change waits for a deletion in flight (the server's deletion transaction may take up to 60 s). */
export const ACCOUNT_DELETION_WAIT_MS = 90_000;

let inFlight: Promise<void> | null = null;
// The deletions whose wait already ran out: one warning each, however many
// paths were waiting (the page change, a sign-in)
const overdue = new WeakSet<Promise<void>>();

/**
 * Mark an account deletion as in flight, from before its request goes out.
 * The returned function ends it: called once the local clean-up after a
 * successful answer has finished, or once the request failed. Calling it
 * again does nothing.
 */
export function beginAccountDeletion(): () => void {
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  inFlight = pending;
  return () => {
    if (inFlight === pending) inFlight = null;
    settle();
  };
}

/** Whether an account deletion of this client is in flight. */
export function accountDeletionInFlight(): boolean {
  return inFlight !== null;
}

/**
 * Resolves when the page may change, or a session start: at once when no
 * deletion is in flight, when the one in flight has ended, or after
 * `timeoutMs` (one warning per deletion). Never rejects. A caller that must
 * keep today's order when nothing is in flight checks
 * `accountDeletionInFlight()` first: awaiting this still costs a microtask.
 */
export function accountDeletionSettled(timeoutMs: number = ACCOUNT_DELETION_WAIT_MS): Promise<void> {
  const pending = inFlight;
  if (!pending) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!overdue.has(pending)) {
        overdue.add(pending);
        console.warn('[Account] The account deletion did not finish its local clean-up in time — leaving the page');
      }
      resolve();
    }, timeoutMs);
    void pending.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

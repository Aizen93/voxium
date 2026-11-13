/**
 * A script's test account: signed in, and registered only when the sign-in
 * is refused as unknown (401).
 *
 * The scripts used to start a registration first and sign in on its 409 (the
 * username is taken). Every such 409 is a failed registration attempt, which
 * the server charges to the address's daily attempt budgets and never gives
 * back (registerAttempt, registerAttemptSubnet). A script that raises those
 * limits while it runs still adds to a counter that existed before it, and
 * that counter keeps its own 24 hours: after one load test (130 conflicts for
 * accounts that had existed for weeks) the next registration from the same
 * machine, another script's or a developer's own, answered 429 for a day.
 * Signed in first, a run that finds its accounts starts no registration.
 *
 * Any other failure of the sign-in (a 429, a 5xx, the network) is thrown as it
 * is: only "no such account" means "create it".
 */
export async function signInOrRegister<T>(signIn: () => Promise<T>, register: () => Promise<T>): Promise<T> {
  try {
    return await signIn();
  } catch (err) {
    if (!refusedAsUnknown(err)) throw err;
  }
  return register();
}

/** An HTTP 401 from the API (an axios error carries it as `response.status`). */
function refusedAsUnknown(err: unknown): boolean {
  const status = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return status === 401;
}

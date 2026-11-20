import { SessionLostError } from './session';

/**
 * Did the server REFUSE the session (401/403), or was the renewal refused for
 * good (SessionLostError)? As opposed to a request that never reached it, or
 * a passing failure. A 401 to a request that went out with a token the client
 * KNEW was expired (its pre-send renewal had just failed transiently,
 * `_renewalFailed` on its config, services/api.ts: a 429 from the refresh
 * limiter, a 5xx, a timeout) answers that stale token, not the session: the
 * refresh token was never judged.
 *
 * The one test of "signed out" for an answer of the REST client: the session
 * restore (authStore) and the screen of a tab that waited for its vault
 * (VaultOwnershipGate) both end the session on it, and on nothing else.
 */
export function isAuthRefusal(err: unknown): boolean {
  if (err instanceof SessionLostError) return true;
  const failed = err as { response?: { status?: unknown }; config?: { _renewalFailed?: unknown } } | null;
  const status = failed?.response?.status;
  if (status === 401 && failed?.config?._renewalFailed) return false;
  return status === 401 || status === 403;
}

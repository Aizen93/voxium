import axios, { type InternalAxiosRequestConfig } from 'axios';
import { connectSocket } from './socket';
import { getAccessToken, getRefreshToken, isTokenOfAnotherAccount, reloadAfterSessionChange } from './tokenStorage';
import { userIdOf } from './tokenClaims';
import { API_BASE, isAccessTokenFresh, shouldRenewBeforeSending, refreshAccessToken, currentSessionEpoch, SessionLostError } from './session';

// The REST base; defined with the session module (which cannot import this
// file) and re-exported for the callers that always took it from here
export { API_BASE };

/** What the interceptors note on a request's config (read back from an error's `config` by the session restore). */
export type SessionRequestConfig = InternalAxiosRequestConfig & {
  /** The 401 path ran once for this request. */
  _retry?: boolean;
  /** The request went out with a stale token because its renewal had just failed transiently. */
  _renewalFailed?: boolean;
  /** The session the request was sent under (`currentSessionEpoch()` at send time). */
  _sessionEpoch?: number;
  /**
   * A credential change (a password change, signing out of the other
   * sessions): renewals are held until its answer is stored
   * (session.runCredentialChange), so the request renews nothing itself,
   * neither before sending nor on a 401; the caller handles that 401.
   */
  _noRenewal?: boolean;
};

/** Two tokens of one account, as far as they tell (decoded for routing only): a token that names no account matches any. */
function sameAccount(a: string, b: string): boolean {
  const ua = userIdOf(a);
  const ub = userIdOf(b);
  return ua === null || ub === null || ua === ub;
}

/** The token a request carried, from its Authorization header (an AxiosHeaders on a sent request, a plain object before). */
function bearerOf(config: SessionRequestConfig): string | null {
  const headers = config.headers as { get?: (name: string) => unknown; Authorization?: unknown } | undefined;
  const value = typeof headers?.get === 'function' ? headers.get('Authorization') : headers?.Authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

export const api = axios.create({
  baseURL: API_BASE,
  // Note: withCredentials is intentionally NOT set. Auth uses Bearer tokens
  // via the Authorization header (not cookies). Setting withCredentials: true
  // triggers strict CORS (origin must be exact, not "*") which breaks on
  // Linux webkit2gtk where the Tauri custom protocol origin may not be echoed
  // correctly by the server.
});

// Attach the auth token to every request. A token known to be expired (the
// window was minimized longer than the access token lives) is renewed FIRST:
// the request then succeeds on its first trip instead of a 401 and a retry,
// and the renewal failing leaves the request to the 401 path below.
api.interceptors.request.use(async (config) => {
  let token = getAccessToken();
  if (token && !(config as SessionRequestConfig)._noRenewal && shouldRenewBeforeSending(token)) {
    try {
      token = await refreshAccessToken();
    } catch (err) {
      if (err instanceof SessionLostError) throw err;
      // Transient: send with what we have, the server decides — and the 401
      // path knows not to spend a second renewal on the same breath
      console.warn('[API] Could not renew the token before the request:', err instanceof Error ? err.message : err);
      (config as SessionRequestConfig)._renewalFailed = true;
    }
  }
  // Never a token of another account than the one this page shows (another
  // tab signed in as someone else): the request is refused unsent and the
  // page reloads onto the stored session (tokenStorage follows the same rule)
  if (token && isTokenOfAnotherAccount(token)) {
    reloadAfterSessionChange();
    throw new SessionLostError('Another account is signed in on this browser');
  }
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // The session this request belongs to: a 401 that comes back after a logout
  // or a new sign-in must not be retried with the NEW session's token (an
  // old request of account A running as account B)
  (config as SessionRequestConfig)._sessionEpoch = currentSessionEpoch();
  return config;
});

/**
 * A 401 answers an access token the server no longer takes. Retried ONCE:
 * with the token stored meanwhile when another request's renewal landed
 * after this one left (no second renewal); not at all when this request's
 * own pre-send renewal just failed transiently (a second attempt in the same
 * breath would only spend the refresh limiter again); otherwise after one
 * shared renewal. A refused renewal has already ended the session
 * (services/session.ts); a transient renewal failure fails this request only,
 * the tokens stay for the next one.
 *
 * Only a request that CARRIED a token, from a session that CAN renew (a
 * refresh token is stored), gets here. A sign-in or a registration carries
 * none and a 401 is its answer (wrong password, expired TOTP challenge):
 * renewing for it ended a session that did not exist — a navigation to the
 * login page, which lost the typed e-mail and the error banner.
 */
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as SessionRequestConfig | undefined;

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !originalRequest._noRenewal) {
      originalRequest._retry = true;
      const sent = bearerOf(originalRequest);
      if (!sent || !getRefreshToken()) return Promise.reject(error);
      // Sent under a session since ended: its 401 is final, whatever is stored now
      if (originalRequest._sessionEpoch !== undefined && originalRequest._sessionEpoch !== currentSessionEpoch()) return Promise.reject(error);
      let accessToken: string;
      const stored = getAccessToken();
      if (stored && stored !== sent && isAccessTokenFresh(stored)) {
        // Never retried as another account: the request's 401 is its caller's
        if (isTokenOfAnotherAccount(stored)) {
          reloadAfterSessionChange();
          return Promise.reject(error);
        }
        if (!sameAccount(stored, sent)) return Promise.reject(error);
        accessToken = stored;
      } else if (originalRequest._renewalFailed) {
        return Promise.reject(error);
      } else {
        try {
          accessToken = await refreshAccessToken();
        } catch (refreshErr) {
          return Promise.reject(refreshErr);
        }
        // The renewal answers only its own account's tokens (services/session.ts): the same rule here
        if (!sameAccount(accessToken, sent)) return Promise.reject(error);
        // The socket re-handshakes with the renewed token (or is reopened if
        // the server had closed its manager while the token was expired)
        connectSocket(accessToken);
      }
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      return api(originalRequest);
    }

    return Promise.reject(error);
  }
);

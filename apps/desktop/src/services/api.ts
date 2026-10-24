import axios, { type InternalAxiosRequestConfig } from 'axios';
import { connectSocket } from './socket';
import { getAccessToken, getRefreshToken } from './tokenStorage';
import { API_BASE, isAccessTokenFresh, shouldRenewBeforeSending, refreshAccessToken, SessionLostError } from './session';

// The REST base; defined with the session module (which cannot import this
// file) and re-exported for the callers that always took it from here
export { API_BASE };

/** What the interceptors note on a request's config (read back from an error's `config` by the session restore). */
export type SessionRequestConfig = InternalAxiosRequestConfig & {
  /** The 401 path ran once for this request. */
  _retry?: boolean;
  /** The request went out with a stale token because its renewal had just failed transiently. */
  _renewalFailed?: boolean;
};

export const api = axios.create({
  baseURL: API_BASE,
  // Note: withCredentials is intentionally NOT set. Auth uses Bearer tokens
  // via the Authorization header (not cookies). Setting withCredentials: true
  // triggers strict CORS (origin must be exact, not "*") which breaks on
  // Linux webkit2gtk where the Tauri custom protocol origin may not be echoed
  // correctly by the server.
});

/** The token a request carried, from its Authorization header (an AxiosHeaders on a sent request, a plain object before). */
function bearerOf(config: SessionRequestConfig): string | null {
  const headers = config.headers as { get?: (name: string) => unknown; Authorization?: unknown } | undefined;
  const value = typeof headers?.get === 'function' ? headers.get('Authorization') : headers?.Authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

// Attach the auth token to every request. A token known to be expired (the
// window was minimized longer than the access token lives) is renewed FIRST:
// the request then succeeds on its first trip instead of a 401 and a retry,
// and the renewal failing leaves the request to the 401 path below.
api.interceptors.request.use(async (config) => {
  let token = getAccessToken();
  if (token && shouldRenewBeforeSending(token)) {
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
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
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

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true;
      const sent = bearerOf(originalRequest);
      if (!sent || !getRefreshToken()) return Promise.reject(error);
      let accessToken: string;
      const stored = getAccessToken();
      if (stored && stored !== sent && isAccessTokenFresh(stored)) {
        accessToken = stored;
      } else if (originalRequest._renewalFailed) {
        return Promise.reject(error);
      } else {
        try {
          accessToken = await refreshAccessToken();
        } catch (refreshErr) {
          return Promise.reject(refreshErr);
        }
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

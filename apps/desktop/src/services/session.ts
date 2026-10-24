import axios from 'axios';
import { getAccessToken, getRefreshToken, setTokens, clearTokens, flushTokenStorage } from './tokenStorage';

/**
 * The signed-in session's access token, and the ONE way it is renewed.
 *
 * Two consumers used to race each other for it. The REST client refreshed on a
 * 401 and the socket re-handshook with whatever token was in storage — so a
 * window restored after a long minimize (the access token lives 15 minutes)
 * had the socket retrying an expired token until some REST request happened
 * to refresh it, and once the socket.io manager had spent its attempts nobody
 * ever reconnected it. And ANY refresh failure, a network blip included, was
 * treated as a dead session: tokens cleared, user sent to the login page.
 *
 * Here: one single-flight refresh shared by every caller; a token is
 * "fresh" by its own `exp` claim (decoded, never trusted for anything but
 * scheduling, and read against the SERVER's clock as its `iat` reveals it);
 * only a definitive refusal of the refresh token (401/403), or no refresh
 * token to send, ends the session — a transient failure is reported to the
 * caller and the tokens stay; a renewal that resolves after a logout stores
 * nothing.
 */

/** The REST base every request is relative to; also the root the incoming-webhook URL is composed on (services/webhooks.ts). */
export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

/** A token expiring within this is treated as expired: a request sent with
 *  it would reach the server after the clock ran out. */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

/** The refresh call has a deadline of its own: every request whose token
 *  reads expired waits on it, and a request hung on a stale keep-alive
 *  connection after a wake used to hold them all until the browser gave up. */
export const REFRESH_TIMEOUT_MS = 15_000;

/** The refresh token was refused for good (revoked, expired, banned), there
 *  was none to send, or the session was ended (logout) while a renewal was
 *  in flight: nothing to retry with. */
export class SessionLostError extends Error {
  constructor(message = 'Session lost') {
    super(message);
    this.name = 'SessionLostError';
  }
}

/** The claims of a JWT, or null when the token cannot be decoded. The
 *  signature is NOT checked: this reads our own stored token to decide when
 *  to renew it, nothing more; the server verifies every request. */
function jwtClaims(token: string): { exp?: number; iat?: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { exp: num(payload.exp), iat: num(payload.iat) };
  } catch {
    // Not an error to report: an undecodable token is sent as is, and the
    // server's 401 is the signal (logging it here would be once per request)
    return null;
  }
}

/** The `exp` claim of a JWT as a millisecond timestamp, or null when the token cannot be decoded. */
export function accessTokenExpiresAt(token: string): number | null {
  const exp = jwtClaims(token)?.exp;
  return exp === undefined ? null : exp * 1000;
}

// The server's clock minus this device's, learnt from the `iat` of every
// renewed token (the server stamped it "now"). A device clock a quarter of an
// hour ahead would otherwise read every fresh token as expired and renew on
// every request — spending the per-IP refresh limiter shared by everyone
// behind the same NAT. Zero until the first renewal (a stored token's iat
// says when IT was issued, not what time it is).
let clockOffsetMs = 0;
// Set when a renewal answers a token that STILL reads expired with the
// offset applied (no iat to learn from, a server mis-clock): proactive
// renewal then stops and the 401 path is the only trigger, as before
let proactiveRenewalSuspended = false;

/** This device's idea of the server's current time. */
function serverNow(): number {
  return Date.now() + clockOffsetMs;
}

/** True while the token has more than the skew left, judged on the server's
 *  clock as far as it is known. An undecodable token is left to the server
 *  (fresh): refusing it here would stop every request. */
export function isAccessTokenFresh(token: string, now: number = serverNow()): boolean {
  const expiresAt = accessTokenExpiresAt(token);
  if (expiresAt === null) return true;
  return expiresAt - now > TOKEN_EXPIRY_SKEW_MS;
}

/** Whether a request should renew `token` BEFORE sending it: it reads expired,
 *  and proactive renewal has not been found unreliable on this device. */
export function shouldRenewBeforeSending(token: string): boolean {
  return !proactiveRenewalSuspended && !isAccessTokenFresh(token);
}

/** A refresh the server REFUSED (as opposed to one that did not reach it, or
 *  that it could not serve right now): a 401 or 403 answer to the refresh call. */
export function isDefinitiveRefreshFailure(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  return status === 401 || status === 403;
}

// What ends the session, replaceable for tests (jsdom cannot navigate)
let navigateToLogin: () => void = () => {
  window.location.href = '/login';
};
let sessionLost = false;
// Bumped whenever the session ends (logout, a refusal): a renewal started
// under an older epoch stores nothing when it lands. Without it a refresh in
// flight at logout resurrected the session: its answer was stored (as the
// logged-out user's tokens) and the REST client's 401 path then opened a new
// socket for that user, with nothing left on screen to tear it down.
let sessionEpoch = 0;
let refreshInFlight: Promise<string> | null = null;

/** The session a request is sent under: a request stamped with an older value
 *  belongs to a session since ended (logout, a new sign-in) and must not be
 *  retried with the new session's token. */
export function currentSessionEpoch(): number {
  return sessionEpoch;
}

/** @internal tests */
export function setSessionLostNavigation(fn: () => void): void {
  navigateToLogin = fn;
  sessionLost = false;
}

/**
 * The session is ending on purpose (logout): a renewal still in flight must
 * not store its answer or reconnect anything. The tokens are the caller's to
 * clear (authStore.logout does).
 */
export function endSessionRenewals(): void {
  sessionEpoch++;
  refreshInFlight = null;
}

/**
 * The session is over: forget the tokens and go to the login page. Idempotent
 * — every queued request fails at once when a refresh is refused, and the
 * socket's handshake may refuse in the same breath; one navigation is enough
 * (and it reloads the page, so the latch never outlives the session). The
 * navigation waits for the persisted clear: in the desktop app the tokens
 * live in the OS credential store, written over IPC, and a reload that
 * outran the clear would load the refused tokens again at the next launch
 * and be refused again — a reload loop.
 */
export function handleSessionLost(): void {
  endSessionRenewals();
  clearTokens();
  if (sessionLost) return;
  sessionLost = true;
  void flushTokenStorage().then(() => navigateToLogin());
}

/**
 * Renew the access token with the stored refresh token. Single-flight: every
 * caller during the round trip shares one request and one answer (the REST
 * 401 retry queue and the socket's expired handshake typically arrive
 * together on resume). Resolves the new access token, already stored.
 *
 * Throws `SessionLostError` after a definitive refusal — and has already
 * ended the session (tokens cleared, login page) — or when the session was
 * ended (logout) while the request was out: nothing is stored then. Throws
 * the transport or server error otherwise, with the tokens untouched: the
 * caller's request fails, the next one tries again.
 */
export function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  const epoch = sessionEpoch;
  const run = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) {
      handleSessionLost();
      throw new SessionLostError('No refresh token');
    }
    let answer: { accessToken: string; refreshToken: string };
    try {
      // Plain axios on purpose: the api instance's interceptors would try to
      // refresh a refused refresh
      const { data } = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken }, { timeout: REFRESH_TIMEOUT_MS });
      answer = data.data as { accessToken: string; refreshToken: string };
    } catch (err) {
      if (epoch !== sessionEpoch) throw new SessionLostError('Session ended during the renewal');
      if (isDefinitiveRefreshFailure(err)) {
        handleSessionLost();
        throw new SessionLostError(err instanceof Error ? err.message : 'Refresh refused');
      }
      throw err;
    }
    // Logged out while the request was out: this answer belongs to nobody
    if (epoch !== sessionEpoch) throw new SessionLostError('Session ended during the renewal');
    setTokens(answer.accessToken, answer.refreshToken);
    learnServerClock(answer.accessToken);
    return answer.accessToken;
  })().finally(() => {
    if (refreshInFlight === run) refreshInFlight = null;
  });
  refreshInFlight = run;
  return run;
}

/** A renewed token's `iat` is the server's "now": the clock offset follows it. */
function learnServerClock(accessToken: string): void {
  const claims = jwtClaims(accessToken);
  if (claims?.iat !== undefined) clockOffsetMs = claims.iat * 1000 - Date.now();
  if (!isAccessTokenFresh(accessToken)) {
    if (!proactiveRenewalSuspended) {
      console.warn('[Session] A renewed token already reads expired on this device\'s clock — renewing on 401 only from here');
    }
    proactiveRenewalSuspended = true;
  }
}

/**
 * An access token good enough to send now: the stored one while it is fresh,
 * a renewed one otherwise. `null` when there is no session to speak of (no
 * stored token). Throws like `refreshAccessToken` when the renewal fails.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;
  if (!shouldRenewBeforeSending(token)) return token;
  return refreshAccessToken();
}

/** @internal tests */
export function _resetSessionForTests(): void {
  refreshInFlight = null;
  sessionLost = false;
  sessionEpoch = 0;
  clockOffsetMs = 0;
  proactiveRenewalSuspended = false;
}

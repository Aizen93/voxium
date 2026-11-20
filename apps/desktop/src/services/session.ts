import axios from 'axios';
import type { RefreshRequest } from '@voxium/shared';
import { API_BASE } from './apiBase';
import {
  getAccessToken, getRefreshToken, setTokens, clearTokens, flushTokenStorage,
  followSharedSession, isSharedWithOtherTabs,
} from './tokenStorage';
import { accountDeletionSettled } from './accountDeletion';
import { readTokenClaims } from './tokenClaims';
import { sessionClientHint } from './sessionClient';

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
 *
 * Every renewal REPLACES the refresh token: the server answers the one it
 * just replaced again for a short grace window and treats it as reused after
 * that, which ends the session once enforcement is on. So the renewal sends
 * only the newest token this browser holds, and stores an answer only while
 * the token it sent is still the stored one:
 *
 * - in the browser build every tab of one browser shares the stored pair
 *   (tokenStorage.ts). Before each refresh request the tab reads the page's
 *   storage again (a tab back from the back-forward cache, or frozen, missed
 *   the `storage` events that kept its memory current), and where Web Locks
 *   exist the renewal runs under one named lock, the re-read after taking it,
 *   so two tabs never renew together: the second finds the first one's pair
 *   and sends nothing. The wait for the lock is bounded; at the bound the
 *   renewal goes on with the re-read alone;
 * - a refresh that got no usable answer (a timeout, a transport error, a
 *   5xx) is sent once more shortly after, inside the same renewal, while the
 *   page is online and nothing else stored a pair meanwhile: an answer lost
 *   on the way back is then recovered within the grace window.
 *
 * The desktop app has one webview: no other tab, no lock, nothing to re-read.
 */

/** The REST base every request is relative to; also the root the incoming-webhook URL is composed on (services/webhooks.ts). */
export { API_BASE };

/** A token expiring within this is treated as expired: a request sent with
 *  it would reach the server after the clock ran out. */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

/** The refresh call has a deadline of its own: every request whose token
 *  reads expired waits on it, and a request hung on a stale keep-alive
 *  connection after a wake used to hold them all until the browser gave up. */
export const REFRESH_TIMEOUT_MS = 15_000;

/**
 * After a refresh that got no usable answer (a timeout, a transport error, a
 * 5xx; never a 429, never a refusal), the one prompt retry goes out this much
 * later. The server answers the token it just replaced again for 120 s
 * (shared `SESSIONS.REUSE_GRACE_SECONDS`): a retry within that recovers an
 * answer that was lost after the server had already rotated the session.
 */
export const REFRESH_RETRY_DELAY_MS = 3_000;

/**
 * The Web Lock every renewal of this browser's tabs runs under (the browser
 * build, where Web Locks exist: a secure origin). Never requested with
 * `steal` or `ifAvailable`: a renewal must never take the lock from a tab
 * that is in the middle of its request.
 */
export const REFRESH_LOCK_NAME = 'voxium-session-refresh';

/**
 * The longest a renewal waits for another tab's to release the lock: more
 * than one renewal's own worst case (two requests of REFRESH_TIMEOUT_MS and
 * the retry's wait), so only a tab that holds the lock without renewing (a
 * frozen page) is outwaited. At the bound the renewal goes on without it,
 * with the re-read of the storage alone (the grace window is the backstop).
 */
export const REFRESH_LOCK_WAIT_MS = 35_000;

/** The part of the Web Locks API the renewal uses (injectable for tests). */
export interface RefreshLockManager {
  request(name: string, options: { mode: 'exclusive'; signal: AbortSignal }, callback: () => Promise<unknown>): Promise<unknown>;
}

/** The refresh token was refused for good (revoked, expired, banned), there
 *  was none to send, or the session was ended (logout) while a renewal was
 *  in flight: nothing to retry with. */
export class SessionLostError extends Error {
  constructor(message = 'Session lost') {
    super(message);
    this.name = 'SessionLostError';
  }
}

/** The `exp` claim of a JWT as a millisecond timestamp, or null when the token
 *  cannot be decoded. The signature is NOT checked: this reads our own stored
 *  token to decide when to renew it, nothing more (services/tokenClaims.ts). */
export function accessTokenExpiresAt(token: string): number | null {
  const exp = readTokenClaims(token)?.exp;
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
 * and be refused again — a reload loop. It also waits for an account deletion
 * of this client in flight: the server refuses the account's requests while
 * it deletes it, and the deletion's local clean-up must run before the page
 * changes (services/accountDeletion.ts).
 */
export function handleSessionLost(): void {
  endSessionRenewals();
  clearTokens();
  if (sessionLost) return;
  sessionLost = true;
  void flushTokenStorage()
    .then(() => accountDeletionSettled())
    .then(() => navigateToLogin());
}

/**
 * Renew the access token with the stored refresh token. Single-flight: every
 * caller during the round trip shares one request and one answer (the REST
 * 401 retry queue and the socket's expired handshake typically arrive
 * together on resume). Resolves the new access token, already stored.
 *
 * In the browser build the renewal first reads the page's storage again,
 * under the renewal lock where there is one: when another tab stored a newer
 * pair than the one this renewal was about to send, and its access token is
 * fresh, that pair is the answer and nothing is sent; with an expired access
 * token, its newer refresh token is the one sent.
 *
 * A refresh that got no usable answer (timeout, transport error, 5xx) is
 * sent once more after REFRESH_RETRY_DELAY_MS, only while the page is not
 * offline, the session has not ended and the stored refresh token is still
 * the one sent. Never after a 429 or a refusal.
 *
 * An answer is stored only while the stored refresh token is still the one
 * this renewal sent: when another tab, or a credential change of this
 * client, stored a pair while the request was out, the answer is dropped and
 * the caller gets the access token stored now.
 *
 * A refusal ends the session only while the refused refresh token is still
 * the stored one. When a newer pair was stored meanwhile, its access token is
 * answered if fresh, else ONE more refresh goes out with its refresh token.
 * At most three requests in all: the first, the prompt retry and that one.
 *
 * Throws `SessionLostError` after a definitive refusal — and has already
 * ended the session (tokens cleared, login page) — or when the session was
 * ended (logout, another tab's sign-out) while the request was out: nothing
 * is stored then. Throws the transport or server error otherwise, with the
 * tokens untouched: the caller's request fails, the next one tries again.
 */
export function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  const epoch = sessionEpoch;
  // The token this renewal was asked for with: another tab's newer pair,
  // found once the lock is held, makes the request unnecessary
  const intended = getRefreshToken();
  const run = (async () => underRefreshLock(() => renew(epoch, intended)))().finally(() => {
    if (refreshInFlight === run) refreshInFlight = null;
  });
  refreshInFlight = run;
  return run;
}

/** The answer of a refresh, checked: two strings, or a transient failure (the tokens stay). */
function refreshAnswerOf(data: unknown): { accessToken: string; refreshToken: string } {
  const answer = (data as { data?: { accessToken?: unknown; refreshToken?: unknown } } | null)?.data;
  if (typeof answer?.accessToken !== 'string' || typeof answer.refreshToken !== 'string' || !answer.accessToken || !answer.refreshToken) {
    throw new Error('The refresh answer carried no token pair');
  }
  return { accessToken: answer.accessToken, refreshToken: answer.refreshToken };
}

/** A refresh that got no answer the client can act on: no response at all (timeout, transport) or a 5xx. Never a 429. */
function gotNoUsableAnswer(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  return status === undefined || status >= 500;
}

/** The page does not say it is offline (a node test process has no navigator). */
function mayRetryNow(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** The stored access token when it is fresh, else null. */
function freshStoredAccessToken(): string | null {
  const stored = getAccessToken();
  return stored && isAccessTokenFresh(stored) ? stored : null;
}

/** The renewal itself, lock already handled. */
async function renew(epoch: number, intended: string | null): Promise<string> {
  if (epoch !== sessionEpoch) throw new SessionLostError('Session ended before the renewal');
  // What other tabs stored since this tab's memory last followed them
  followSharedSession();
  let refreshToken = getRefreshToken();
  if (!refreshToken) {
    handleSessionLost();
    throw new SessionLostError('No refresh token');
  }
  if (refreshToken !== intended) {
    // Another tab renewed while this one waited (for the lock, or with its
    // memory frozen): its pair is the answer when it is fresh
    const adopted = freshStoredAccessToken();
    if (adopted) return adopted;
  }
  let promptRetried = false;
  let newerTried = false;
  for (;;) {
    let answer: { accessToken: string; refreshToken: string };
    try {
      // Plain axios on purpose: the api instance's interceptors would try to
      // refresh a refused refresh
      const body: RefreshRequest = { refreshToken, client: sessionClientHint() };
      const { data } = await axios.post(`${API_BASE}/auth/refresh`, body, { timeout: REFRESH_TIMEOUT_MS });
      answer = refreshAnswerOf(data);
    } catch (err) {
      if (epoch !== sessionEpoch) throw new SessionLostError('Session ended during the renewal');
      if (isDefinitiveRefreshFailure(err)) {
        // The refused token is no longer the stored one: another tab (they
        // share the page storage in the browser build) or this client's own
        // credential change stored a newer pair while the request was out.
        // Ending the session now would clear THAT pair — every tab follows
        // the removal — and sign out a session that is still valid.
        followSharedSession();
        const stored = getRefreshToken();
        if (stored && stored !== refreshToken) {
          const adopted = freshStoredAccessToken();
          if (adopted) return adopted;
          if (!newerTried) {
            newerTried = true;
            refreshToken = stored;
            continue;
          }
          // Replaced once more while the retry was out: still not ours to
          // clear; this renewal fails, the tokens stay, the next one decides
          throw new Error('The refresh token was replaced during the renewal', { cause: err });
        }
        handleSessionLost();
        throw new SessionLostError(err instanceof Error ? err.message : 'Refresh refused');
      }
      if (promptRetried || !gotNoUsableAnswer(err) || !mayRetryNow()) throw err;
      promptRetried = true;
      await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
      if (epoch !== sessionEpoch) throw new SessionLostError('Session ended during the renewal');
      followSharedSession();
      if (getRefreshToken() !== refreshToken) {
        // Another tab stored a pair during the wait: its answer is ours
        const adopted = freshStoredAccessToken();
        if (adopted) return adopted;
        throw err;
      }
      if (!mayRetryNow()) throw err;
      continue;
    }
    // Logged out while the request was out: this answer belongs to nobody
    if (epoch !== sessionEpoch) throw new SessionLostError('Session ended during the renewal');
    followSharedSession();
    if (getRefreshToken() !== refreshToken) {
      // Another tab (or a credential change of this client) stored a pair
      // while the request was out: that pair stands, this answer is dropped
      const current = getAccessToken();
      if (current) return current;
      throw new SessionLostError('The session was ended while the renewal was out');
    }
    setTokens(answer.accessToken, answer.refreshToken);
    learnServerClock(answer.accessToken);
    return answer.accessToken;
  }
}

// The page's Web Locks, unless a test installed its own (null: none)
let lockManagerOverride: RefreshLockManager | null | undefined;

/** The lock manager the renewal runs under: none in the desktop app, nor where the page has none. */
function refreshLocks(): RefreshLockManager | null {
  if (!isSharedWithOtherTabs()) return null;
  if (lockManagerOverride !== undefined) return lockManagerOverride;
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: RefreshLockManager }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Run `work` under the renewal lock where the browser has one, waiting for it
 * at most REFRESH_LOCK_WAIT_MS: past that, or when the lock manager refuses,
 * `work` runs without it. The wait is ended with an abort signal, which
 * cannot touch a lock once granted: no tab ever loses the lock mid-request.
 */
async function underRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = refreshLocks();
  if (!locks) return work();
  const waited = new AbortController();
  const timer = setTimeout(() => waited.abort(), REFRESH_LOCK_WAIT_MS);
  let granted = false;
  try {
    return (await locks.request(REFRESH_LOCK_NAME, { mode: 'exclusive', signal: waited.signal }, () => {
      granted = true;
      clearTimeout(timer);
      return work();
    })) as T;
  } catch (err) {
    // An error of the renewal itself, thrown inside the lock
    if (granted) throw err;
    clearTimeout(timer);
    if (waited.signal.aborted) {
      console.warn('[Session] Another tab held the renewal lock too long — renewing without it');
    } else {
      console.warn('[Session] The renewal lock is not available — renewing without it:', err instanceof Error ? err.message : String(err));
    }
    return work();
  }
}

/** @internal tests: the lock manager the renewal uses (undefined: the page's own). */
export function _setRefreshLocksForTests(locks: RefreshLockManager | null | undefined): void {
  lockManagerOverride = locks;
}

/** A renewed token's `iat` is the server's "now": the clock offset follows it. */
function learnServerClock(accessToken: string): void {
  const claims = readTokenClaims(accessToken);
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
  lockManagerOverride = undefined;
}

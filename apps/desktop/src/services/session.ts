import axios from 'axios';
import type { RefreshRequest } from '@voxium/shared';
import { API_BASE } from './apiBase';
import {
  getAccessToken, getRefreshToken, setTokens, clearSessionTokens, flushTokenStorage,
  followSharedSession, isSharedWithOtherTabs, reloadAfterSessionChange,
  markCredentialChange, credentialChangeInFlightUntil, waitForCredentialChange, twinSyncPending, awaitTwinSync,
} from './tokenStorage';
import { accountDeletionSettled } from './accountDeletion';
import { isSameSession, readTokenClaims, sessionIdOf, userIdOf } from './tokenClaims';
import { loginPathFor, type LoginReason } from '../utils/loginReasons';
import { sessionClientHint } from './sessionClient';
import { claimPageNavigation, _resetPageNavigationForTests } from './pageNavigation';
import { CREDENTIAL_CHANGE_MARK_MS } from './credentialChangeLimits';

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
 * - a credential change of any tab (a password change, "sign out of all
 *   other sessions") is marked in flight in the shared storage, for its
 *   account, and every renewal of a tab holding a pair of that account
 *   waits for its answer before it sends anything, the lock or not
 *   (tokenStorage.markCredentialChange); a refusal received while one is in
 *   flight is not final until its answer has been looked for;
 * - a not-remembered tab that loaded its pair, or came back from the
 *   back-forward cache, asks its twins for the newest one first, and its
 *   first renewal waits briefly for the answer (tokenStorage.awaitTwinSync);
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
let navigateToLogin: (path: string) => void = (path) => {
  window.location.href = path;
};
// The one trip to the sign-in page of this page load, once asked for: the
// reason it shows can still be given until it leaves
let loginNavigation: { reason: LoginReason | null } | null = null;
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

/** @internal tests: what navigates, and a fresh page load (no navigation asked for yet) */
export function setSessionLostNavigation(fn: (path: string) => void): void {
  navigateToLogin = fn;
  loginNavigation = null;
  _resetPageNavigationForTests();
}

/**
 * How long the reason of a `force:logout` this tab ignored is kept for its
 * trip to the sign-in page. The tab ignores one that ends a session it has
 * let go of to follow another session of the account (services/socket.ts);
 * when the server ended that other session too ("sign out of all other
 * sessions" from another device), the tab learns it only when its socket,
 * reopened with the session held, is refused and the renewal that follows is
 * refused too. That trip starts within: the reopen's spread after the
 * server's disconnect (up to 5 s), at most one handshake renewal per 30 s
 * (socket.ts HANDSHAKE_REFRESH_MIN_INTERVAL_MS), and a refresh request's own
 * deadline and retry (15 s and 3 s). Twice the handshake renewal's interval
 * covers them; a trip later than that is not taken to be about that end.
 */
export const IGNORED_SESSION_END_WINDOW_MS = 60_000;

// The reason of the last force:logout this tab ignored, and when (memory only)
let ignoredSessionEnd: { reason: LoginReason; at: number } | null = null;

/**
 * A `force:logout` with `reason` (a code of the closed list, or null) was
 * ignored: it ended a session this tab no longer holds. A trip to the sign-in
 * page that starts within IGNORED_SESSION_END_WINDOW_MS, with no reason of
 * its own, says that reason. Kept in memory only, and forgotten at a sign-in
 * (forgetIgnoredSessionEnd).
 */
export function noteIgnoredSessionEnd(reason: LoginReason | null): void {
  if (reason === null) return;
  ignoredSessionEnd = { reason, at: Date.now() };
}

/** A new session begins (a sign-in, a registration): an end ignored before it says nothing about it. */
export function forgetIgnoredSessionEnd(): void {
  ignoredSessionEnd = null;
}

/** The reason of a force:logout ignored within the window, else null (and forgotten). */
function recentlyIgnoredSessionEnd(): LoginReason | null {
  const noted = ignoredSessionEnd;
  if (noted === null) return null;
  const age = Date.now() - noted.at;
  if (age >= 0 && age <= IGNORED_SESSION_END_WINDOW_MS) return noted.reason;
  ignoredSessionEnd = null;
  return null;
}

/**
 * Go to the sign-in page: ONCE per page load, after the queued writes of the
 * session storage have landed (in the desktop app the OS credential store is
 * written over IPC: a reload that outran the clear would restore the session
 * just ended) and after an account deletion of this client in flight has
 * finished its local clean-up (services/accountDeletion.ts). A server's
 * `force:logout` and a refusal can land together: every caller after the
 * first only adds its reason when the first gave none, so the sign-in page
 * says why (utils/loginReasons.ts) and a second navigation never replaces
 * the first. A trip asked for with no reason, within
 * IGNORED_SESSION_END_WINDOW_MS of a force:logout this tab ignored, says that
 * one's reason. The trip is the page's one navigation (services/pageNavigation.ts):
 * a reload onto another session asked for before it stands, and this goes
 * nowhere; one asked for after it goes nowhere either.
 */
export function goToLoginPage(reason: LoginReason | null = null): void {
  if (loginNavigation) {
    if (reason !== null && loginNavigation.reason === null) loginNavigation.reason = reason;
    return;
  }
  if (!claimPageNavigation('login')) return;
  const trip: { reason: LoginReason | null } = { reason: reason ?? recentlyIgnoredSessionEnd() };
  loginNavigation = trip;
  void flushTokenStorage()
    .then(() => accountDeletionSettled())
    .then(() => navigateToLogin(loginPathFor(trip.reason)));
}

/**
 * The session is ending on purpose (logout): a renewal still in flight must
 * not store its answer or reconnect anything. The tokens are the caller's to
 * clear (authStore.logout does).
 */
export function endSessionRenewals(): void {
  sessionEpoch++;
  refreshInFlight = null;
  // A credential change still out belongs to the session that ended: its
  // answer is dropped (its stillCurrent() is false), and nothing of it holds
  // the next session up: not its hold on the renewals, not the queue of
  // changes, not the renewal lock (it lets go of it on this signal)
  renewalHold = null;
  credentialChangeQueue = Promise.resolve();
  // ... and its mark no longer holds any tab's renewals
  ownCredentialChangeMark?.();
  ownCredentialChangeMark = null;
  const ended = sessionEnd;
  sessionEnd = deferred();
  ended.resolve();
  cancelBackgroundRenewals();
}

/** A promise and its resolver. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Resolved when the current session's renewals end (endSessionRenewals)
let sessionEnd = deferred();

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
 *
 * `endedToken` is the refresh token that was refused (null when there was
 * none to send). The pair is cleared only while it is still of that session
 * (tokenStorage.clearSessionTokens): when another tab stored a different
 * session meanwhile, it is left as it is and the page reloads onto it
 * instead of going to the login page.
 */
export function handleSessionLost(endedToken: string | null = null): void {
  endSessionRenewals();
  if (clearSessionTokens(endedToken) === 'replaced') {
    reloadAfterSessionChange();
    return;
  }
  goToLoginPage(null);
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
 * After a refresh that got no usable answer, renewals also go out in the
 * background (BACKGROUND_RENEWAL_DELAYS_MS), whether or not anything asks:
 * an answer lost after the server rotated the session is then recovered
 * within its grace window even across a short outage.
 *
 * Whatever is stored now is answered only when it belongs to the account
 * the renewal was for: another account's session (another tab signed in as
 * someone else) is never handed to the caller; the renewal fails with
 * `SessionLostError`, nothing is cleared, and the page reloads onto it.
 *
 * Throws `SessionLostError` after a definitive refusal — and has already
 * ended the session (tokens cleared, login page) — or when the session was
 * ended (logout, another tab's sign-out) while the request was out: nothing
 * is stored then. Throws the transport or server error otherwise, with the
 * tokens untouched: the caller's request fails, the next one tries again.
 */
export function refreshAccessToken(): Promise<string> {
  return startRenewal(true);
}

function startRenewal(promptRetry: boolean): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  const epoch = sessionEpoch;
  // The token this renewal was asked for with: another tab's newer pair,
  // found once the lock is held, makes the request unnecessary
  const intended = getRefreshToken();
  const run = (async () => {
    // A credential change of this client is on the wire: its answer is the
    // new pair, and a refresh token of the old version would be refused once
    // it commits. Waited for before the lock (the change holds it)
    while (renewalHold) await renewalHold;
    return underRefreshLock(() => renew(epoch, intended, promptRetry));
  })().finally(() => {
    if (refreshInFlight === run) refreshInFlight = null;
  });
  refreshInFlight = run;
  return run;
}

// ─── Background renewals after a lost answer ─────────────────────────────────

/**
 * After a refresh that got no usable answer (a timeout, a transport error, a
 * 5xx), up to three more renewals go out on their own this long after it,
 * each only while the session has not ended and the stored refresh token is
 * still the one that went unanswered, and the chain stops at the first real
 * answer (a new pair, a refusal, a 429). All within the 120 s the server
 * answers a replaced token again (shared `SESSIONS.REUSE_GRACE_SECONDS`):
 * a rotation whose answer was lost, followed by a short outage, is
 * recovered before the old token counts as reused. Each sends one request
 * (no prompt retry of its own), and none while the page is offline or while
 * another renewal is out.
 */
export const BACKGROUND_RENEWAL_DELAYS_MS: readonly number[] = [10_000, 30_000, 75_000];

interface BackgroundChain {
  epoch: number;
  refreshToken: string;
  timers: Array<ReturnType<typeof setTimeout>>;
}
let backgroundChain: BackgroundChain | null = null;

function cancelBackgroundRenewals(): void {
  if (!backgroundChain) return;
  for (const timer of backgroundChain.timers) clearTimeout(timer);
  backgroundChain = null;
}

/** A refresh with `refreshToken` got no usable answer: the background chain for it, unless one is already set. */
function scheduleBackgroundRenewals(epoch: number, refreshToken: string): void {
  if (backgroundChain && backgroundChain.epoch === epoch && backgroundChain.refreshToken === refreshToken) return;
  cancelBackgroundRenewals();
  const chain: BackgroundChain = { epoch, refreshToken, timers: [] };
  backgroundChain = chain;
  const last = BACKGROUND_RENEWAL_DELAYS_MS.length - 1;
  chain.timers = BACKGROUND_RENEWAL_DELAYS_MS.map((delay, at) => setTimeout(() => {
    void backgroundRenewal(chain).finally(() => {
      // Its last timer has fired: a later refresh that goes unanswered starts a chain of its own
      if (at === last && backgroundChain === chain) backgroundChain = null;
    });
  }, delay));
}

async function backgroundRenewal(chain: BackgroundChain): Promise<void> {
  if (backgroundChain !== chain) return;
  if (chain.epoch !== sessionEpoch || getRefreshToken() !== chain.refreshToken) {
    // Renewed (or signed out) since: nothing left to recover
    cancelBackgroundRenewals();
    return;
  }
  // A renewal already out decides this one; an offline page waits for the next
  if (refreshInFlight || !mayRetryNow()) return;
  try {
    await startRenewal(false);
    if (backgroundChain === chain) cancelBackgroundRenewals();
  } catch (err) {
    // No usable answer again: the next one of the chain. Anything else (a
    // refusal, a 429, the session ended) is an answer: the chain ends
    if (!gotNoUsableAnswer(err) && backgroundChain === chain) cancelBackgroundRenewals();
    if (!(err instanceof SessionLostError)) {
      console.warn('[Session] A background renewal failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

/** Two tokens of one account, as far as they tell (decoded for routing only): a token that names no account matches any. */
function sameAccount(a: string | null, b: string | null): boolean {
  const ua = userIdOf(a);
  const ub = userIdOf(b);
  return ua === null || ub === null || ua === ub;
}

/**
 * `token`, stored now, as this renewal's answer — only when it belongs to
 * the account the renewal was for (`renewedWith`, the refresh token it was
 * started or sent with). Otherwise another tab signed in as someone else:
 * nothing of that session reaches this page's caller, nothing is cleared,
 * and the page reloads onto it.
 */
function ownAccountsToken(token: string, renewedWith: string | null): string {
  if (!sameAccount(token, renewedWith)) {
    console.info('[Session] Another account is signed in on this browser now — reloading onto it');
    reloadAfterSessionChange();
    throw new SessionLostError('Another account is signed in on this browser');
  }
  return token;
}

// ─── Credential changes ──────────────────────────────────────────────────────
//
// A password change and "sign out of all other sessions" move the account to
// a new token version: once one commits, every refresh token of the old
// version is refused, this device's included, and the answer carries the
// device's new pair. So around either of them (shared RevokeOtherSessionsResponse):
// a renewal in flight lands first; renewals are then held until the answer is
// stored (a renewal sent meanwhile would carry an old-version token and be
// refused); a renewal answer that arrives after the change is never stored
// (its pair is of the old version: renew() drops any answer whose token is no
// longer the stored one); one change at a time.

/** A credential change in flight: every renewal of this client waits for it. */
let renewalHold: Promise<void> | null = null;
/** Credential changes run one after the other. */
let credentialChangeQueue: Promise<unknown> = Promise.resolve();

/**
 * The deadline of a credential change's request (CREDENTIAL_CHANGE_TIMEOUT_MS)
 * and how far ahead its mark says it may still be answered
 * (CREDENTIAL_CHANGE_MARK_MS): defined in a module without imports, which
 * the Cookie Policy reads too.
 */
export { CREDENTIAL_CHANGE_TIMEOUT_MS, CREDENTIAL_CHANGE_MARK_MS } from './credentialChangeLimits';

/** The removal of this tab's mark of a credential change in flight, while there is one. */
let ownCredentialChangeMark: (() => void) | null = null;

/** A credential change of this tab's account, made in a tab of this browser, is marked in flight (tokenStorage), now. */
function credentialChangeMarked(): boolean {
  return credentialChangeInFlightUntil(CREDENTIAL_CHANGE_MARK_MS) !== null;
}

/**
 * Wait while that change is marked in flight (tokenStorage.waitForCredentialChange).
 * Resolves whether the session `epoch` ended during the wait: the caller then
 * sends nothing. Called only once credentialChangeMarked() said so, so that a
 * renewal with no change to wait for awaits nothing.
 */
async function credentialChangeWaitEnded(epoch: number): Promise<boolean> {
  await waitForCredentialChange(CREDENTIAL_CHANGE_MARK_MS);
  return epoch !== sessionEpoch;
}

/**
 * Run a credential change of this client (`change` sends it and stores its
 * answer). In order: one change at a time; a renewal in flight lands first;
 * renewals are held until `change` has settled; in the browser build the
 * change runs under the renewal lock, so no other tab renews meanwhile
 * either, after reading the shared storage again; an access token that has
 * expired is renewed inline, under that lock, before the change goes out.
 *
 * `change` receives `stillCurrent()`: whether its answer may be stored now.
 * The refresh token is read under the lock as the change goes out; the
 * answer belongs to that session only, so stillCurrent() is false once the
 * session has ended here (logout, a new sign-in: the epoch), and once the
 * shared storage, read again, no longer holds a pair of that session:
 * another tab signed in (as anyone) or out meanwhile, and its pair stands.
 * A pair of the same session at another generation (a twin's, a tab that
 * renewed without the lock) is still that session: the answer, of the
 * account's new version, is the one to keep. A token issued before sessions
 * names no session; only the very same token counts then (the answer opens a
 * new session for it, and another tab's new sign-in to the same account is
 * not this change's to overwrite). The caller asks once, before storing
 * anything of the answer.
 *
 * The session ending while the change is out releases everything the
 * change holds for the next one (endSessionRenewals): the renewals it held,
 * the queue, and the renewal lock. A change runs only in the session it was
 * asked in, read when it is queued: one whose session ended while it waited
 * (for a change queued before it, for a renewal in flight, for the lock)
 * sends nothing and rejects with SessionLostError.
 *
 * The request `change` sends must not renew by itself (the api's
 * `_noRenewal`): a renewal waiting for the change it is part of would never
 * settle. A 401 answer is the caller's to handle once this has settled
 * (renew, and a refused renewal signs out).
 */
export function runCredentialChange<T>(change: (stillCurrent: () => boolean) => Promise<T>): Promise<T> {
  // The session the change is asked in: it goes out in that one or not at all
  const epoch = sessionEpoch;
  const run = credentialChangeQueue.then(() => {
    if (epoch !== sessionEpoch) throw new SessionLostError('The session ended before the credential change went out');
    return credentialChangeStep(epoch, change);
  });
  credentialChangeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Whether the pair stored now is of the session `startedWith` (the refresh
 * token a credential change went out with) names: the same sid, or for a
 * token that names none, that very token.
 */
function storedSessionIs(startedWith: string | null): boolean {
  const accessToken = getAccessToken();
  const refreshToken = getRefreshToken();
  if (startedWith === null || accessToken === null || refreshToken === null) return false;
  if (sessionIdOf(startedWith) === null) return refreshToken === startedWith;
  return isSameSession({ accessToken, refreshToken }, startedWith);
}

async function credentialChangeStep<T>(epoch: number, change: (stillCurrent: () => boolean) => Promise<T>): Promise<T> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  renewalHold = hold;
  // Started before the hold, so not held by it: its answer is stored first
  const before = refreshInFlight;
  const ended = sessionEnd.promise;
  try {
    if (before) {
      try {
        await before;
      } catch (err) {
        if (err instanceof SessionLostError) throw err;
        // A transient failure: the stored token decides below
      }
    }
    let outcome!: Promise<T>;
    await underRefreshLock(async () => {
      if (epoch !== sessionEpoch) throw new SessionLostError('The session ended before the credential change went out');
      // The change goes out with the newest pair of this session there is
      if (twinSyncPending()) {
        await awaitTwinSync();
        if (epoch !== sessionEpoch) throw new SessionLostError('The session ended before the credential change went out');
      }
      // Another tab's credential change is out (an origin without Web Locks,
      // or one past the lock's bound): this one goes out on what it stores
      if (credentialChangeMarked() && (await credentialChangeWaitEnded(epoch))) {
        throw new SessionLostError('The session ended before the credential change went out');
      }
      followOtherTabsOrStop();
      const token = getAccessToken();
      if (!token) throw new SessionLostError('No session for the credential change');
      if (shouldRenewBeforeSending(token)) await renew(epoch, getRefreshToken());
      // The session this change is made in, read as it goes out
      const startedWith = getRefreshToken();
      // Every tab of the browser build sees the change in flight, without a
      // lock, until its answer is stored and written (tokenStorage). Written
      // after the inline renewal above: this tab never waits for its own
      const unmark = markCredentialChange(Date.now() + CREDENTIAL_CHANGE_MARK_MS);
      ownCredentialChangeMark = unmark;
      outcome = (async () => change(() => epoch === sessionEpoch && followSharedSession() !== 'reloading' && storedSessionIs(startedWith)))()
        .finally(() => flushTokenStorage().then(() => {
          unmark?.();
          if (ownCredentialChangeMark === unmark) ownCredentialChangeMark = null;
        }));
      // The lock is held until the change has settled, or until the session
      // it is made in ends: nothing of that session needs it any more
      await Promise.race([outcome.then(() => undefined, () => undefined), ended]);
    });
    return await outcome;
  } finally {
    if (renewalHold === hold) renewalHold = null;
    release();
  }
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

/**
 * What other tabs stored since this tab's memory last followed them
 * (tokenStorage.followSharedSession). The storage holding another account's
 * session than the one on screen stops the renewal: the page is reloading
 * onto it, and nothing more is sent from this one.
 */
function followOtherTabsOrStop(): void {
  if (followSharedSession() === 'reloading') {
    throw new SessionLostError('Another tab signed in to another account: the page reloads onto it');
  }
}

/** The renewal itself, lock already handled. `promptRetry`: false for a background renewal (one request). */
async function renew(epoch: number, intended: string | null, promptRetry = true): Promise<string> {
  if (epoch !== sessionEpoch) throw new SessionLostError('Session ended before the renewal');
  // This tab asked the twins of its not-remembered session for its newest
  // pair (a tab restored, reloaded or back from the back-forward cache missed
  // their renewals): its first renewal waits for their answer, briefly
  // (tokenStorage.TWIN_SYNC_WAIT_MS), and sends what it holds then
  if (twinSyncPending()) {
    await awaitTwinSync();
    if (epoch !== sessionEpoch) throw new SessionLostError('Session ended while the other tabs of this session were asked');
  }
  // A credential change of another tab is out: a refresh token sent now is
  // of the version it moves away from once it commits. This renewal waits
  // for its answer (bounded by the change's own deadline), then goes on with
  // what is stored then
  if (credentialChangeMarked() && (await credentialChangeWaitEnded(epoch))) {
    throw new SessionLostError('Session ended while a credential change was out');
  }
  // What other tabs stored since this tab's memory last followed them
  followOtherTabsOrStop();
  let refreshToken = getRefreshToken();
  if (!refreshToken) {
    handleSessionLost();
    throw new SessionLostError('No refresh token');
  }
  if (refreshToken !== intended) {
    // Another tab renewed while this one waited (for the lock, or with its
    // memory frozen): its pair is the answer when it is fresh
    const adopted = freshStoredAccessToken();
    if (adopted) return ownAccountsToken(adopted, intended);
  }
  let promptRetried = !promptRetry;
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
        followOtherTabsOrStop();
        let stored = getRefreshToken();
        if (stored === refreshToken && credentialChangeMarked()) {
          // Refused while a credential change of another tab is out: the
          // token may be of the version that change moved away from, so the
          // refusal is not final. Its answer, once stored, is this renewal's
          if (await credentialChangeWaitEnded(epoch)) throw new SessionLostError('Session ended while a credential change was out');
          followOtherTabsOrStop();
          stored = getRefreshToken();
        }
        if (stored && stored !== refreshToken) {
          const adopted = freshStoredAccessToken();
          if (adopted) return ownAccountsToken(adopted, refreshToken);
          if (!newerTried) {
            newerTried = true;
            // never another account's token, sent on this page's behalf
            refreshToken = ownAccountsToken(stored, refreshToken);
            continue;
          }
          // Replaced once more while the retry was out: still not ours to
          // clear; this renewal fails, the tokens stay, the next one decides
          throw new Error('The refresh token was replaced during the renewal', { cause: err });
        }
        handleSessionLost(refreshToken);
        throw new SessionLostError(err instanceof Error ? err.message : 'Refresh refused');
      }
      // The answer may have been lost after the server rotated the session:
      // renewals go out in the background too, within its grace window
      if (gotNoUsableAnswer(err)) scheduleBackgroundRenewals(epoch, refreshToken);
      if (promptRetried || !gotNoUsableAnswer(err) || !mayRetryNow()) throw err;
      promptRetried = true;
      await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
      if (epoch !== sessionEpoch) throw new SessionLostError('Session ended during the renewal');
      followOtherTabsOrStop();
      if (getRefreshToken() !== refreshToken) {
        // Another tab stored a pair during the wait: its answer is ours
        const adopted = freshStoredAccessToken();
        if (adopted) return ownAccountsToken(adopted, refreshToken);
        throw err;
      }
      if (!mayRetryNow()) throw err;
      continue;
    }
    // Logged out while the request was out: this answer belongs to nobody
    if (epoch !== sessionEpoch) throw new SessionLostError('Session ended during the renewal');
    followOtherTabsOrStop();
    if (getRefreshToken() !== refreshToken) {
      // Another tab (or a credential change of this client) stored a pair
      // while the request was out: that pair stands, this answer is dropped
      const current = getAccessToken();
      if (current) return ownAccountsToken(current, refreshToken);
      throw new SessionLostError('The session was ended while the renewal was out');
    }
    setTokens(answer.accessToken, answer.refreshToken);
    learnServerClock(answer.accessToken);
    if (backgroundChain?.refreshToken === refreshToken) cancelBackgroundRenewals();
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
  renewalHold = null;
  credentialChangeQueue = Promise.resolve();
  sessionEnd = deferred();
  loginNavigation = null;
  ignoredSessionEnd = null;
  _resetPageNavigationForTests();
  cancelBackgroundRenewals();
  sessionEpoch = 0;
  clockOffsetMs = 0;
  proactiveRenewalSuspended = false;
  lockManagerOverride = undefined;
}

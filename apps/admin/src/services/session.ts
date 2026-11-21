import axios from 'axios';
import type { LogoutRequest, RefreshRequest } from '@voxium/shared';
import { getAccessToken, getRefreshToken, getStoredRefreshToken, setTokens, clearTokens } from './tokenStorage';

export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

/** Bound on the refresh call: a hung request must not hold every other one. */
export const REFRESH_TIMEOUT_MS = 15_000;
/** Bound on the best-effort server sign-out. */
export const LOGOUT_TIMEOUT_MS = 10_000;

/**
 * After a refresh request that got no answer at all (a network error, a
 * timeout) or a 5xx, up to three more renewals run in the background, at
 * these offsets from that failure. The server may have rotated the token
 * before the answer was lost, and it answers the replaced token again only for
 * two minutes. The failed request left at most REFRESH_TIMEOUT_MS before its
 * failure, so the last renewal leaves at most 15 + 75 + 5 = 95 s after the
 * server could have rotated: inside the two minutes.
 */
export const TRANSPORT_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000, 75_000];
/**
 * Each background renewal runs up to this much before or after its offset, so
 * the tabs of one outage do not come back in the same instant.
 */
export const TRANSPORT_RETRY_JITTER_MS = 5_000;

/** Refresh requests one renewal may send: the first, and one more with a newer pair another tab stored while the first was out. */
const MAX_REFRESH_ATTEMPTS = 2;

/** The session ended (refused refresh, no refresh token, another account's pair stored): no request of it goes out again. */
export class SessionLostError extends Error {
  constructor(message = 'Session lost') {
    super(message);
    this.name = 'SessionLostError';
  }
}

/**
 * A request this tab would have sent with another account's token (another
 * tab signed in as someone else and this tab has not reloaded yet): it is
 * never sent, and the page reloads onto the stored session.
 */
export class AccountChangedError extends Error {
  constructor() {
    super('Another account is signed in on this device');
    this.name = 'AccountChangedError';
  }
}

/** The background renewals that follow one lost refresh answer. */
interface RetryChain {
  /** The refresh token that got no answer: the chain stops once it is no longer the stored one. */
  sentRefreshToken: string;
  epoch: number;
  failedAt: number;
  /** Index in TRANSPORT_RETRY_DELAYS_MS of the next background renewal. */
  next: number;
}

let inFlight: Promise<string> | null = null;
// Bumped by every end of a session in this tab (a sign-out, a sign-in that
// replaces the stored session, a refusal): a renewal answer that arrives after
// it stores nothing, or it would bring the ended session back.
let epoch = 0;
// One navigation per page load (to the sign-in page, or a reload onto the
// stored session): the first one wins, so a reason it carries is kept.
let navigationPending = false;
// The account this tab is signed in as (set by authStore at a sign-in or a
// restore, cleared by every end of a session here), or null.
let tabAccount: string | null = null;
let transportRetryTimer: ReturnType<typeof setTimeout> | null = null;
// Told when a background renewal got an answer (the pair was renewed, or the
// session ended): authStore uses it on the sign-in page
let backgroundRenewalListener: (() => void) | null = null;
// [0, 1): the spread of the background renewals; replaceable for tests
let random: () => number = Math.random;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

/** The session this tab is in: a value read before an await and changed after it means the session ended meanwhile. */
export function currentSessionEpoch(): number {
  return epoch;
}

function claimsOf(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
  } catch {
    // Not an error to report: an undecodable token carries no claim
    return null;
  }
}

/**
 * The `sid` claim of one of our tokens, or null when it carries none. The
 * signature is NOT checked: this only tells two stored tokens apart, the
 * server verifies every request.
 */
function sessionIdOf(token: string): string | null {
  const sid = claimsOf(token)?.sid;
  return typeof sid === 'string' && sid !== '' ? sid : null;
}

/**
 * The `userId` claim of one of our tokens, or null when it carries none or
 * the token cannot be decoded. The signature is NOT checked: this only
 * routes (is the stored session this tab's account?), the server verifies
 * every request.
 */
export function userIdOf(token: string): string | null {
  const userId = claimsOf(token)?.userId;
  return typeof userId === 'string' && userId !== '' ? userId : null;
}

/** Whether two tokens name two different accounts (a token naming none differs from nothing). */
export function differentAccounts(a: string, b: string): boolean {
  const ua = userIdOf(a);
  const ub = userIdOf(b);
  return ua !== null && ub !== null && ua !== ub;
}

/**
 * Whether two tokens belong to one session. A renewal replaces both tokens
 * and keeps the session, so they are compared by their `sid` claims when both
 * carry one; otherwise only the same token is the same session.
 */
export function sameSession(a: string, b: string): boolean {
  if (a === b) return true;
  const sid = sessionIdOf(a);
  return sid !== null && sid === sessionIdOf(b);
}

/**
 * Whether the stored pair is the session `token` (an access or a refresh
 * token of it) belongs to, or nothing is stored. A tab clears the storage
 * every tab shares only then: a different session there (a sign-in in another
 * tab) is not this tab's to clear.
 */
export function storedSessionIs(token: string | null): boolean {
  const access = getAccessToken();
  const refresh = getRefreshToken();
  if (access === null && refresh === null) return true;
  if (token === null) return false;
  return (access !== null && sameSession(access, token)) || (refresh !== null && sameSession(refresh, token));
}

/** The bearer token an Authorization header value carries, or null. */
export function bearerOf(header: unknown): string | null {
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Go to `href`, unless a navigation of this page load is already on its way:
 * the first one wins (requests failing together, a force:logout and a 401
 * would otherwise each set the address again, and the last one would win).
 */
export function navigateOnce(href: string): void {
  if (navigationPending) return;
  navigationPending = true;
  window.location.href = href;
}

/** This tab is signed in as `userId` (a sign-in, a restore). */
export function setTabSignedInAs(userId: string): void {
  tabAccount = userId;
}

/** Whether this tab believes it is signed in. */
export function isTabSignedIn(): boolean {
  return tabAccount !== null;
}

/** The account this tab is signed in as, or null. */
export function tabAccountId(): string | null {
  return tabAccount;
}

/**
 * Whether this tab may send `token`: it names the account the tab is signed
 * in as, or the tab is signed in as nobody (a restore, the sign-in page), or
 * the token names no account (every token the server issues names one).
 */
export function mayCarry(token: string): boolean {
  if (tabAccount === null) return true;
  const userId = userIdOf(token);
  return userId === null || userId === tabAccount;
}

/**
 * The stored session belongs to another account than the one this tab
 * shows: the page reloads onto it (the same navigation authStore makes when
 * the `storage` event arrives). Only a signed-in tab reloads; the sign-in
 * page stays where it is.
 */
export function reloadOntoStoredSession(): void {
  if (tabAccount !== null) navigateOnce('/');
}

function cancelTransportRetry(): void {
  if (transportRetryTimer !== null) {
    clearTimeout(transportRetryTimer);
    transportRetryTimer = null;
  }
}

/**
 * The session this tab renewed with `sentRefreshToken` (null: there was none
 * to send) is over: it is cleared while it is still the stored one. A tab
 * that was signed in goes to the sign-in page; on the sign-in page (a
 * background renewal, a restore) nothing navigates.
 */
function handleSessionLost(sentRefreshToken: string | null): void {
  const wasSignedIn = tabAccount !== null;
  endSessionRenewals();
  if (getRefreshToken() === sentRefreshToken) clearTokens();
  if (wasSignedIn) navigateOnce('/login');
}

/** A local end of the session: no renewal in flight may store tokens after this, and none is shared with the next session. */
export function endSessionRenewals(): void {
  tabAccount = null;
  epoch++;
  inFlight = null;
  cancelTransportRetry();
}

/**
 * A refresh request the server may have acted on without the client learning
 * it: no answer at all, or a 5xx (a gateway can answer 502, 503 or 504 after
 * the server has already replaced the token). Never a 429, a 401 or a 403.
 */
function mayHaveRotated(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response === undefined) return err.code !== 'ERR_CANCELED';
  return err.response.status >= 500 && err.response.status <= 599;
}

function notifyBackgroundRenewal(): void {
  if (backgroundRenewalListener === null) return;
  try {
    backgroundRenewalListener();
  } catch (err) {
    console.error('[Auth] Background renewal listener failed:', describe(err));
  }
}

/**
 * The next background renewal of `chain`, while this tab is in the same
 * session and the stored refresh token is still the one that got no answer.
 * A renewal that starts meanwhile (a request's 401, the socket) replaces the
 * chain; one that gets an answer ends it.
 */
function scheduleTransportRetry(chain: RetryChain): void {
  cancelTransportRetry();
  const index = chain.next;
  if (index >= TRANSPORT_RETRY_DELAYS_MS.length) return;
  const jitter = Math.round((random() * 2 - 1) * TRANSPORT_RETRY_JITTER_MS);
  const wait = Math.max(0, chain.failedAt + TRANSPORT_RETRY_DELAYS_MS[index] + jitter - Date.now());
  transportRetryTimer = setTimeout(() => {
    transportRetryTimer = null;
    if (epoch !== chain.epoch || getRefreshToken() !== chain.sentRefreshToken) return;
    startRenewal({ ...chain, next: index + 1 }).then(
      () => notifyBackgroundRenewal(),
      (err: unknown) => {
        if (err instanceof SessionLostError) {
          notifyBackgroundRenewal();
          return;
        }
        console.warn('[Auth] Background token renewal failed:', describe(err));
      },
    );
  }, wait);
}

/** Another account's pair is stored: not this renewal's to use or to clear. */
function anotherAccountStored(): never {
  reloadOntoStoredSession();
  throw new SessionLostError('Another account is signed in');
}

async function runRefresh(startEpoch: number, chain: RetryChain | null): Promise<string> {
  const first = getStoredRefreshToken();
  if (!first) {
    handleSessionLost(null);
    throw new SessionLostError('No refresh token');
  }
  // Signed in as one account with another's pair stored (a sign-in in another
  // tab this tab has not followed yet): that session is not this tab's to renew
  if (!mayCarry(first.token)) anotherAccountStored();
  // A token another tab stored is used only for the account this renewal is for
  const sameAccount = (token: string) => mayCarry(token) && !differentAccounts(token, first.token);
  let sent = first;
  for (let attempt = 1; ; attempt++) {
    let accessToken: unknown;
    let newRefreshToken: unknown;
    try {
      const body: RefreshRequest = { refreshToken: sent.token, client: 'admin' };
      const { data } = await axios.post(`${API_BASE}/auth/refresh`, body, { timeout: REFRESH_TIMEOUT_MS });
      accessToken = data?.data?.accessToken;
      newRefreshToken = data?.data?.refreshToken;
    } catch (err) {
      if (startEpoch !== epoch) throw new SessionLostError('Signed out during renewal');
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      // Only a refusal of the refresh itself ends the session; a network
      // error, a timeout, a 429 or a 5xx fails the request and keeps the tokens
      if (status !== 401 && status !== 403) {
        if (mayHaveRotated(err)) {
          scheduleTransportRetry(chain === null
            ? { sentRefreshToken: sent.token, epoch, failedAt: Date.now(), next: 0 }
            : { ...chain, sentRefreshToken: sent.token });
        }
        throw err;
      }
      const stored = getStoredRefreshToken();
      if (stored && stored.token !== sent.token) {
        // Another tab stored a newer pair while this request was out: ending
        // the session now would clear THAT pair, which is still valid
        if (!sameAccount(stored.token)) anotherAccountStored();
        const storedAccess = getAccessToken();
        if (storedAccess) {
          if (!sameAccount(storedAccess)) anotherAccountStored();
          return storedAccess;
        }
        if (attempt < MAX_REFRESH_ATTEMPTS) {
          sent = stored;
          continue;
        }
        throw new Error('The refresh token was replaced during the renewal', { cause: err });
      }
      handleSessionLost(sent.token);
      throw new SessionLostError('Refresh refused');
    }
    if (startEpoch !== epoch) throw new SessionLostError('Signed out during renewal');
    if (typeof accessToken !== 'string' || typeof newRefreshToken !== 'string') {
      throw new Error('Malformed refresh answer');
    }
    const stored = getStoredRefreshToken();
    if (!stored || stored.token !== sent.token) {
      // The storage moved on while the request was out (another tab renewed,
      // signed out or signed in): this answer is dropped, the stored session
      // is the one to use
      if (stored && !sameAccount(stored.token)) anotherAccountStored();
      const storedAccess = getAccessToken();
      if (stored && storedAccess) {
        if (!sameAccount(storedAccess)) anotherAccountStored();
        return storedAccess;
      }
      if (stored && attempt < MAX_REFRESH_ATTEMPTS) {
        sent = stored;
        continue;
      }
      handleSessionLost(sent.token);
      throw new SessionLostError('The session ended in another tab');
    }
    // Every renewal rotates the refresh token: keep BOTH, where the pair was read
    setTokens(accessToken, newRefreshToken, sent.remembered);
    return accessToken;
  }
}

function startRenewal(chain: RetryChain | null): Promise<string> {
  if (inFlight) return inFlight;
  // A newer renewal replaces the background ones still to come
  cancelTransportRetry();
  const run: Promise<string> = runRefresh(epoch, chain).finally(() => {
    // An ended session has dropped it already, and the next one may have its own
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

/**
 * Renew the access token. Single-flight: callers that find the token expired
 * at the same time share one request (the REST 401 path and the socket
 * handshake both come here). Resolves the access token to use, stored.
 */
export function refreshAccessToken(): Promise<string> {
  return startRenewal(null);
}

/**
 * Call `listener` after each background renewal that got an answer: the pair
 * was renewed, or the session ended. Replaces the previous listener.
 */
export function onBackgroundRenewalSettled(listener: (() => void) | null): void {
  backgroundRenewalListener = listener;
}

/**
 * Tell the server this session is over. Best effort and never awaited by the
 * UI: a plain request with no bearer and no interceptor, bounded, its failure
 * logged by message only.
 */
export function endServerSession(refreshToken: string): void {
  const body: LogoutRequest = { refreshToken };
  axios
    .post(`${API_BASE}/auth/logout`, body, { timeout: LOGOUT_TIMEOUT_MS })
    .catch((err: unknown) => {
      console.warn('[Auth] Server sign-out failed:', describe(err));
    });
}

/** @internal tests: a deterministic spread of the background renewals */
export function _setSessionRandomForTests(fn: () => number): void {
  random = fn;
}

/** @internal tests: the module's state as at page load (the background renewal listener is kept) */
export function _resetSessionForTests(): void {
  endSessionRenewals();
  navigationPending = false;
  random = Math.random;
}

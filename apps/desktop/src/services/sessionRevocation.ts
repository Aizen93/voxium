import axios from 'axios';
import type { LogoutRequest } from '@voxium/shared';
import { API_BASE } from './apiBase';
import { SIGN_OUT_RETRY_MAX_AGE_MS } from './sessionRevocationLimits';

/**
 * Ending a session ON THE SERVER, after this device let go of it.
 *
 * A sign-out completes locally at once, whatever the network does
 * (authStore.logout); the server is then told with `POST /auth/logout`
 * `{ refreshToken }`, which ends the session the token names whatever its
 * generation. The first try is a `fetch` with `keepalive`, which the browser
 * carries on after the page goes away: a sign-out followed at once by a
 * reload (another tab's session taken up, tokenStorage.reloadAfterSessionChange)
 * is not cut. Later tries are plain axios requests. Neither is the api
 * instance (its interceptors would renew a session being ended); the call is
 * never awaited by the sign-out, stores nothing and touches no session
 * epoch: its answer can bring nothing back.
 *
 * A sign-out that could not reach the server (no answer, a 429, a 5xx) is
 * tried again while the app runs: on the `online` event and after
 * SIGN_OUT_RETRY_DELAYS_MS (the last delay repeating). It is kept in memory
 * only, never on disk, at most SIGN_OUT_RETRY_MAX_ENTRIES at once (the oldest
 * goes first), and dropped on any other answer, when the page goes away
 * (`pagehide`) and SIGN_OUT_RETRY_MAX_AGE_MS after the sign-out. The Cookie
 * Policy quotes that bound in both languages (components/legal/
 * CookiePolicyContent.en.tsx and .fr.tsx, which read it from
 * sessionRevocationLimits.ts, the module without imports that defines it).
 * Past it the session ends by itself when it has gone unused for its idle
 * window, and every other device of the account lists it and can end it.
 *
 * The same bound holds the refresh token of a session a sign-in replaced
 * (holdReplacedSession): the server is told to end it only once the new
 * sign-in has succeeded.
 *
 * No import of the session storage or the renewal: nothing here can store a
 * token or end a session locally. Nothing token-shaped is ever logged.
 */

/** The one request's deadline. */
export const SIGN_OUT_REQUEST_TIMEOUT_MS = 10_000;
/** Sign-outs waiting to reach the server at once; a further one pushes the oldest out. */
export const SIGN_OUT_RETRY_MAX_ENTRIES = 3;
/** How long a sign-out that has not reached the server is kept for another try (defined with the legal pages' other bounds). */
export { SIGN_OUT_RETRY_MAX_AGE_MINUTES, SIGN_OUT_RETRY_MAX_AGE_MS } from './sessionRevocationLimits';
/** The waits before each further try, after a failed one; the last repeats until the entry is dropped. */
export const SIGN_OUT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 300_000];

interface Entry {
  refreshToken: string;
  /** Requests sent so far. */
  attempts: number;
  inFlight: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const entries: Entry[] = [];
let listening = false;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A keepalive try the server answered with anything but a success. */
class SignOutAnswerError extends Error {
  constructor(readonly status: number) {
    super(`The sign-out was answered with status ${status}`);
    this.name = 'SignOutAnswerError';
  }
}

/** No answer at all (timeout, transport), a 429 or a 5xx: the session may still be live there, worth another try. */
function worthRetrying(err: unknown): boolean {
  if (err instanceof SignOutAnswerError) return err.status === 429 || err.status >= 500;
  // fetch: no answer at all (a TypeError) or the try's own deadline (an abort)
  if (err instanceof TypeError || (err as { name?: unknown } | null)?.name === 'AbortError') return true;
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  return status === undefined || status === 429 || status >= 500;
}

/**
 * The first try: a `fetch` the browser carries on after the page goes away
 * (`keepalive`), with the same body and the same deadline as the others. The
 * deadline aborts only a try still waiting while the page lives; nothing else
 * aborts it (dropping the entry when the page goes away does not).
 */
async function sendKeepalive(body: LogoutRequest): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), SIGN_OUT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
    if (!response.ok) throw new SignOutAnswerError(response.status);
  } finally {
    clearTimeout(timer);
  }
}

/** One try: the first through sendKeepalive (where the page has fetch), every later one a plain axios request. */
function send(entry: Entry): Promise<unknown> {
  const body: LogoutRequest = { refreshToken: entry.refreshToken };
  if (entry.attempts === 1 && typeof fetch === 'function') return sendKeepalive(body);
  return axios.post(`${API_BASE}/auth/logout`, body, { timeout: SIGN_OUT_REQUEST_TIMEOUT_MS });
}

function drop(entry: Entry): void {
  const at = entries.indexOf(entry);
  if (at < 0) return;
  entries.splice(at, 1);
  if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
  clearTimeout(entry.expiryTimer);
}

function attempt(entry: Entry): void {
  if (entry.inFlight || !entries.includes(entry)) return;
  entry.inFlight = true;
  entry.attempts++;
  send(entry).then(
    () => drop(entry),
    (err: unknown) => {
      entry.inFlight = false;
      if (!entries.includes(entry)) return;
      if (!worthRetrying(err)) {
        // Any other answer (a 4xx: an older server without the route, a
        // malformed token): nothing a retry would change
        drop(entry);
        return;
      }
      console.warn('[Session] The sign-out did not reach the server yet — trying again later:', describe(err));
      const delay = SIGN_OUT_RETRY_DELAYS_MS[Math.min(entry.attempts - 1, SIGN_OUT_RETRY_DELAYS_MS.length - 1)];
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        attempt(entry);
      }, delay);
    },
  );
}

/** The network came back: every waiting sign-out is tried now. */
function retryAllNow(): void {
  for (const entry of [...entries]) {
    if (entry.inFlight) continue;
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    attempt(entry);
  }
}

/** The page goes away: nothing outlives it. */
function dropEverything(): void {
  for (const entry of [...entries]) drop(entry);
  forgetReplacedSession();
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('online', retryAllNow);
  window.addEventListener('pagehide', dropEverything);
}

/**
 * Tell the server to end the session `refreshToken` names. Returns at once;
 * the request, and its retries, run on their own. A no-op without a token,
 * and for a token already waiting.
 */
export function endSessionOnServer(refreshToken: string | null | undefined): void {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return;
  if (entries.some((entry) => entry.refreshToken === refreshToken)) return;
  listen();
  if (entries.length >= SIGN_OUT_RETRY_MAX_ENTRIES) {
    console.warn('[Session] Too many sign-outs are waiting to reach the server — the oldest is given up');
    drop(entries[0]);
  }
  const entry: Entry = {
    refreshToken,
    attempts: 0,
    inFlight: false,
    retryTimer: null,
    expiryTimer: setTimeout(() => {
      if (!entries.includes(entry)) return;
      console.warn('[Session] A sign-out could not reach the server in time — given up');
      drop(entry);
    }, SIGN_OUT_RETRY_MAX_AGE_MS),
  };
  entries.push(entry);
  attempt(entry);
}

// ─── A session a sign-in replaces ────────────────────────────────────────────
//
// A sign-in (or the completion of a registration) first discards whatever
// session this device still holds (authStore.discardStaleSession: a launch
// that could not verify it kept it for a retry). That session is abandoned
// on this device, so the server is told to end it — but only once the new
// sign-in has succeeded (its two-factor step or the registration's code step
// included): a sign-in that fails must not end, on the server, a session
// another tab or a retry may still be using. Until then its refresh token is
// held in memory, for at most SIGN_OUT_RETRY_MAX_AGE_MS, across failed
// attempts, and dropped when the page goes away.

let replaced: { refreshToken: string; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * The session a sign-in is about to discard. A null token (nothing held now)
 * keeps one an earlier attempt held: a registration's first step discards
 * before its code step does.
 */
export function holdReplacedSession(refreshToken: string | null): void {
  if (refreshToken === null || refreshToken.length === 0) return;
  if (replaced?.refreshToken === refreshToken) return;
  forgetReplacedSession();
  listen();
  replaced = {
    refreshToken,
    timer: setTimeout(() => {
      replaced = null;
    }, SIGN_OUT_RETRY_MAX_AGE_MS),
  };
}

/**
 * The sign-in succeeded with `newRefreshToken`: the server is told to end the
 * session it replaced, unless that is the very same token.
 */
export function endReplacedSession(newRefreshToken: string): void {
  const held = replaced;
  forgetReplacedSession();
  if (held && held.refreshToken !== newRefreshToken) endSessionOnServer(held.refreshToken);
}

/** Nothing is held any more. */
export function forgetReplacedSession(): void {
  if (replaced) clearTimeout(replaced.timer);
  replaced = null;
}

/** @internal tests: how many sign-outs are waiting, and whether a replaced session is held. */
export function _sessionRevocationStateForTests(): { waiting: number; replacedHeld: boolean } {
  return { waiting: entries.length, replacedHeld: replaced !== null };
}

/** @internal tests */
export function _resetSessionRevocationForTests(): void {
  for (const entry of [...entries]) drop(entry);
  forgetReplacedSession();
  if (listening && typeof window !== 'undefined') {
    window.removeEventListener('online', retryAllNow);
    window.removeEventListener('pagehide', dropEverything);
  }
  listening = false;
}

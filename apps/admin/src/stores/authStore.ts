import { create } from 'zustand';
import axios from 'axios';
import { api } from '../services/api';
import { connectSocket, disconnectSocket, followStoredSession } from '../services/socket';
import {
  getAccessToken, getRefreshToken, setTokens, clearTokens, getTrustedDeviceToken, setTrustedDeviceToken,
  onStoredSessionChange,
} from '../services/tokenStorage';
import {
  bearerOf, endServerSession, endSessionRenewals, isTabSignedIn, mayCarry, navigateOnce, onBackgroundRenewalSettled,
  SessionLostError, setTabSignedInAs, storedSessionIs, userIdOf,
} from '../services/session';
import type { LoginRequest, TotpVerifyRequest, User } from '@voxium/shared';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  /** The first session restore of this page load is running (the app shows its loading screen). */
  isLoading: boolean;
  /** A session restore is running (the first, or "Try again" on the sign-in page). */
  isRestoring: boolean;
  /**
   * The stored session could not be restored because the server did not
   * answer (or answered with an error that is not a refusal, or not in time):
   * the tokens are kept, and the sign-in page offers to try again.
   */
  restoreUnavailable: boolean;
  isSubmitting: boolean;
  error: string | null;
  totpRequired: boolean;
  totpToken: string | null;

  login: (email: string, password: string) => Promise<void>;
  verifyTOTP: (code: string) => Promise<void>;
  cancelTOTP: () => void;
  /** The administrator signs out: ends the session on the server too. */
  logout: () => void;
  /**
   * The session ended without this tab asking the server (force:logout,
   * another tab's sign-out): local only. Given the token of the session that
   * ended, the stored pair is cleared only while it is that session; true
   * when it was (or nothing was stored), false when the storage holds
   * another session, left in place.
   */
  endSessionLocally: (sessionToken?: string | null) => boolean;
  /** Restore the stored session. Single-flight: concurrent calls share one attempt. */
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

/**
 * The longest one session restore may take, all of it (the check, a renewal,
 * the retry, a second check when the stored session changed meanwhile): it
 * then ends in the "could not be restored" state with the tokens kept, and
 * "Try again" starts a new attempt.
 */
export const RESTORE_TIMEOUT_MS = 15_000;

/**
 * Bound on the sign-in and the two-factor requests. Longer than the restore's:
 * the server hashes the password before it answers, and a request it has
 * already handled when the client gives up has opened a session the client
 * never learns of (and, for the two-factor step, used up the code), so the
 * bound only ends a wait that is not coming back.
 */
export const SIGN_IN_TIMEOUT_MS = 30_000;

/** Sign-in and the two-factor step: no stored bearer, never renewed or retried, bounded. */
const SIGN_IN_REQUEST = { skipAuth: true, timeout: SIGN_IN_TIMEOUT_MS } as const;

/** Checks one restore attempt may make: the first, and one more when the stored session changed while the first was out. */
const MAX_RESTORE_RUNS = 2;

const ACCESS_DENIED_MESSAGE = 'Access denied. Admin privileges required.';

class AccessDeniedError extends Error {
  constructor() {
    super(ACCESS_DENIED_MESSAGE);
    this.name = 'AccessDeniedError';
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

function isAdminUser(user: unknown): user is User {
  if (typeof user !== 'object' || user === null) return false;
  const role = (user as { role?: unknown }).role;
  return role === 'superadmin' || role === 'admin';
}

/** An answer that is a user object at all (a proxy page or an HTML fallback is not). */
function isUserObject(value: unknown): value is User {
  return typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { role?: unknown }).role === 'string';
}

/** What to show for a failed sign-in step: the route's own error, the access refusal, or the fallback. */
function signInError(err: unknown, fallback: string): string {
  if (err instanceof AccessDeniedError) return err.message;
  const routeError: unknown = axios.isAxiosError(err) ? err.response?.data?.error : undefined;
  return typeof routeError === 'string' && routeError !== '' ? routeError : fallback;
}

/**
 * A sign-in succeeded: the new session replaces whatever was stored. A
 * renewal of the old session in flight stores nothing after this, a socket of
 * the old session is closed, the new pair is stored, the tab is signed in as
 * `userId` and its socket opened, and only then is the server told the old
 * session is over (best effort). The trusted-device token is not part of the
 * session and stays.
 */
function startSession(accessToken: string, refreshToken: string, staleRefreshToken: string | null, userId: string) {
  endSessionRenewals();
  disconnectSocket();
  // Another tab may have replaced the stored pair while the sign-in request
  // was out: that session is overwritten here, so it is ended too
  const storedNow = getRefreshToken();
  setTokens(accessToken, refreshToken, true);
  setTabSignedInAs(userId);
  connectSocket(accessToken);
  const ended = new Set<string>();
  for (const stale of [staleRefreshToken, storedNow]) {
    if (!stale || stale === refreshToken || ended.has(stale)) continue;
    ended.add(stale);
    endServerSession(stale);
  }
}

/** The pair a sign-in step answered, or null when the answer does not hold one. */
function tokenPair(answer: { accessToken?: unknown; refreshToken?: unknown } | undefined): { accessToken: string; refreshToken: string } | null {
  if (typeof answer?.accessToken !== 'string' || typeof answer.refreshToken !== 'string') return null;
  return { accessToken: answer.accessToken, refreshToken: answer.refreshToken };
}

function isRefusal(err: unknown): boolean {
  return axios.isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403);
}

/** One restore attempt: given up when it outlives RESTORE_TIMEOUT_MS (it then applies nothing). */
interface RestoreAttempt {
  abandoned: boolean;
  controller: AbortController;
}

/**
 * What one check of the stored session ended with: done (applied, or nothing
 * to apply), or the stored session is no longer the one the answer was for.
 */
type RestoreRun = 'done' | 'moved';

let restoreInFlight: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => {
  async function restoreRun(attempt: RestoreAttempt): Promise<RestoreRun> {
    // Given up on, or overtaken by a sign-in in this tab: this answer applies nothing
    const overtaken = () => attempt.abandoned || isTabSignedIn();
    const startToken = getAccessToken();
    if (!startToken) {
      set({ restoreUnavailable: false });
      return 'done';
    }
    // The session this check is for: the bearer the answered request carried
    // (a renewal may have replaced the one read here)
    const checked = (header: unknown) => bearerOf(header) ?? startToken;

    let response;
    try {
      response = await api.get('/auth/me', { sessionRestore: true, signal: attempt.controller.signal });
    } catch (err: unknown) {
      if (overtaken()) return 'done';
      if (err instanceof SessionLostError) {
        // The renewal was refused (services/session.ts cleared the session
        // while it was still the stored one), or found another account's pair
        // stored (left in place). Whatever is stored now is not what was refused.
        if (getAccessToken() !== null) return 'moved';
        set({ restoreUnavailable: false });
        return 'done';
      }
      if (isRefusal(err)) {
        // Refused: the stored session is over, while it is still the one refused
        if (!storedSessionIs(checked(axios.isAxiosError(err) ? err.config?.headers?.Authorization : undefined))) return 'moved';
        clearTokens();
        set({ restoreUnavailable: false });
        return 'done';
      }
      // Not a refusal (network, timeout, 429, 5xx): the tokens stay, and
      // the sign-in page says so and offers to try again
      console.warn('[Auth] Session restore failed, keeping the session:', describe(err));
      set({ restoreUnavailable: true });
      return 'done';
    }
    if (overtaken()) return 'done';

    const user: unknown = response?.data?.data;
    if (!isUserObject(user)) {
      // A 2xx that is not the API's answer (a proxy page, an HTML fallback):
      // nothing was refused, the tokens stay
      console.warn('[Auth] Session restore failed, keeping the session:', 'the answer to /auth/me is not a user');
      set({ restoreUnavailable: true });
      return 'done';
    }
    const answeredFor = checked(response.config?.headers?.Authorization);

    if (!isAdminUser(user)) {
      // Not an administrator: the session must not stay open, on the server either
      if (!storedSessionIs(answeredFor)) return 'moved';
      const refreshToken = getRefreshToken();
      if (refreshToken) endServerSession(refreshToken);
      clearTokens();
      set({ restoreUnavailable: false });
      return 'done';
    }

    // Applied only to the session the answer was for, and only while it is
    // still the stored one: another tab may have signed out (nothing stored,
    // which storedSessionIs alone would accept) or signed in as someone else
    const stored = getAccessToken();
    const storedAccount = stored === null ? null : userIdOf(stored);
    if (stored === null || !storedSessionIs(answeredFor) || (storedAccount !== null && storedAccount !== user.id)) {
      return 'moved';
    }
    // The socket first: if it throws, the tab is not signed in
    connectSocket(stored);
    setTabSignedInAs(user.id);
    set({ user, isAuthenticated: true, restoreUnavailable: false });
    return 'done';
  }

  async function restore(attempt: RestoreAttempt): Promise<void> {
    set({ isRestoring: true });
    try {
      for (let run = 1; ; run++) {
        if (attempt.abandoned || isTabSignedIn()) return;
        if (await restoreRun(attempt) === 'done') return;
        if (attempt.abandoned || isTabSignedIn()) return;
        // The stored session changed while the check was out
        if (getAccessToken() === null) {
          // Another tab signed out: signed out here too, nothing to keep
          set({ restoreUnavailable: false });
          return;
        }
        if (run >= MAX_RESTORE_RUNS) {
          console.warn('[Auth] Session restore failed, keeping the session:', 'the stored session changed during the restore');
          set({ restoreUnavailable: true });
          return;
        }
      }
    } catch (err: unknown) {
      // Never left on the loading screen, never an unhandled rejection; the
      // sign-in page says the session could not be restored and offers to try again
      console.error('[Auth] Session restore failed:', describe(err));
      if (!attempt.abandoned && !isTabSignedIn()) set({ restoreUnavailable: true });
    } finally {
      // An attempt given up on has ended these already, and "Try again" may run its own
      if (!attempt.abandoned) set({ isLoading: false, isRestoring: false });
    }
  }

  /** One restore attempt, bounded: past RESTORE_TIMEOUT_MS it is given up on and the single-flight slot is free. */
  function boundedRestore(): Promise<void> {
    const attempt: RestoreAttempt = { abandoned: false, controller: new AbortController() };
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        attempt.abandoned = true;
        attempt.controller.abort();
        console.warn('[Auth] Session restore failed, keeping the session:', `no answer within ${RESTORE_TIMEOUT_MS} ms`);
        if (!isTabSignedIn()) set({ restoreUnavailable: true });
        set({ isLoading: false, isRestoring: false });
        resolve();
      }, RESTORE_TIMEOUT_MS);
      void restore(attempt).finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    user: null,
    isAuthenticated: false,
    isLoading: true,
    isRestoring: false,
    restoreUnavailable: false,
    isSubmitting: false,
    error: null,
    totpRequired: false,
    totpToken: null,

    login: async (email, password) => {
      set({ isSubmitting: true, error: null });
      // Read now, ended only once this sign-in has succeeded: a sign-in that
      // fails (a wrong password, the server still restarting) must not cost
      // the stored session, which another tab may be using
      const staleRefreshToken = getRefreshToken();
      try {
        const trustedDeviceToken = getTrustedDeviceToken();
        const body: LoginRequest = { email, password, rememberMe: true, trustedDeviceToken, client: 'admin' };
        const { data } = await api.post('/auth/login', body, SIGN_IN_REQUEST);
        const answer = data?.data;

        if (answer?.totpRequired) {
          set({ totpRequired: true, totpToken: answer.totpToken, isSubmitting: false });
          return;
        }

        const pair = tokenPair(answer);
        if (!isAdminUser(answer?.user)) {
          // The server just opened a session for an account that may not use
          // the dashboard: end it there too
          if (pair) endServerSession(pair.refreshToken);
          throw new AccessDeniedError();
        }
        if (!pair) throw new Error('Malformed sign-in answer');

        startSession(pair.accessToken, pair.refreshToken, staleRefreshToken, answer.user.id);
        set({ user: answer.user, isAuthenticated: true, isSubmitting: false, restoreUnavailable: false });
      } catch (err: unknown) {
        set({ error: signInError(err, 'Login failed'), isSubmitting: false });
        throw err;
      }
    },

    verifyTOTP: async (code) => {
      const totpToken = get().totpToken;
      if (!totpToken) return;
      set({ isSubmitting: true, error: null });
      // As at sign-in: the stored session is ended only once this step succeeded
      const staleRefreshToken = getRefreshToken();
      try {
        const body: TotpVerifyRequest = { totpToken, code, client: 'admin' };
        const { data } = await api.post('/auth/totp/verify', body, SIGN_IN_REQUEST);
        const answer = data?.data;
        const pair = tokenPair(answer);

        if (!isAdminUser(answer?.user)) {
          if (pair) endServerSession(pair.refreshToken);
          set({ totpRequired: false, totpToken: null });
          throw new AccessDeniedError();
        }
        if (!pair) throw new Error('Malformed sign-in answer');

        startSession(pair.accessToken, pair.refreshToken, staleRefreshToken, answer.user.id);
        if (typeof answer.trustedDeviceToken === 'string' && answer.trustedDeviceToken !== '') {
          setTrustedDeviceToken(answer.trustedDeviceToken);
        }
        set({ user: answer.user, isAuthenticated: true, isSubmitting: false, totpRequired: false, totpToken: null, restoreUnavailable: false });
      } catch (err: unknown) {
        set({ error: signInError(err, 'Invalid verification code'), isSubmitting: false });
        throw err;
      }
    },

    cancelTOTP: () => {
      set({ totpRequired: false, totpToken: null, error: null });
    },

    logout: () => {
      // Captured BEFORE anything is cleared; the person is signed out here at
      // once and the server is told in the background
      const refreshToken = getRefreshToken();
      if (!isTabSignedIn() || (refreshToken !== null && !mayCarry(refreshToken))) {
        // This tab's session has already ended (a force:logout, a refused
        // renewal: the page is on its way to the sign-in page), or another
        // account's pair is stored (a sign-in in another tab, this tab not
        // reloaded yet, and that sign-in ended this tab's session): what is
        // stored is not this tab's to clear or to end on the server
        endTabSession();
        return;
      }
      get().endSessionLocally();
      if (refreshToken) endServerSession(refreshToken);
    },

    endSessionLocally: (sessionToken) => {
      const ours = sessionToken === undefined || storedSessionIs(sessionToken);
      endTabSession();
      if (ours) clearTokens();
      return ours;
    },

    checkAuth: () => {
      if (!restoreInFlight) {
        const run: Promise<void> = boundedRestore().finally(() => {
          if (restoreInFlight === run) restoreInFlight = null;
        });
        restoreInFlight = run;
      }
      return restoreInFlight;
    },

    clearError: () => set({ error: null }),
  };
});

/**
 * This tab's session ends in memory: no renewal of it stores anything any
 * more, its socket is closed, the page shows the sign-in form (a two-factor
 * step under way included). The storage is left as it is.
 */
function endTabSession(): void {
  endSessionRenewals();
  disconnectSocket();
  useAuthStore.setState({ user: null, isAuthenticated: false, restoreUnavailable: false, totpRequired: false, totpToken: null });
}

// Another tab changed the stored session. Its refresh token removed there (a
// sign-out, a lost session): this tab ends its own too, in memory only,
// without telling the server (the tab that removed it did, or the server
// ended it) and without clearing anything (what is stored is another tab's,
// a sign-in under way there included). Replaced there (a sign-in): requests
// read the storage each time, and the socket is moved onto it, unless it is
// another account's: then the page reloads onto it. A change while this tab
// is not signed in needs nothing here: a restore under way compares the
// stored session with the one its answer was for before it applies anything.
onStoredSessionChange(() => {
  const state = useAuthStore.getState();
  if (!state.isAuthenticated) return;
  if (getRefreshToken() === null) {
    endTabSession();
    return;
  }
  // A pair of another ACCOUNT: this tab must not go on showing the old one
  // while it holds the new one's session, so the page reloads onto it
  const storedAccess = getAccessToken();
  const storedUserId = storedAccess === null ? null : userIdOf(storedAccess);
  if (storedUserId !== null && state.user && storedUserId !== state.user.id) {
    navigateOnce('/');
    return;
  }
  followStoredSession();
});

// A background renewal (after a refresh request that got no answer) settled
// while the sign-in page says the session could not be restored: the session
// it renewed is restored now, and one it ended is no longer said to be kept.
onBackgroundRenewalSettled(() => {
  const state = useAuthStore.getState();
  if (state.isAuthenticated || !state.restoreUnavailable) return;
  if (getAccessToken() === null) {
    useAuthStore.setState({ restoreUnavailable: false });
    return;
  }
  // A sign-in under way (its request out, or its two-factor step shown) decides on its own
  if (state.isSubmitting || state.totpRequired) return;
  void state.checkAuth();
});

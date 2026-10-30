import { create } from 'zustand';
import { api, type SessionRequestConfig } from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';
import {
  getAccessToken, setTokens, clearTokens, isRemembered, hydrateTokens,
  getTrustedDeviceToken, setTrustedDeviceToken, clearTrustedDeviceToken,
} from '../services/tokenStorage';
import { SessionLostError, endSessionRenewals } from '../services/session';
import { useServerStore } from './serverStore';
import { useChatStore } from './chatStore';
import { useVoiceStore } from './voiceStore';
import { resetAccountStores } from './resetStores';
import { processImage } from '../utils/imageProcessing';
import i18n from '../i18n';
import { getTranslatedError } from '../utils/serverErrors';
import type { User, RegistrationConsent } from '@voxium/shared';
import { PowExpiredError, PowAbortedError, SIGNUP, USERNAME_TAKEN_MESSAGE } from '@voxium/shared';
import { solveRegistrationPowOffThread } from '../services/powSolver';
import { forgetLocalE2EState } from '../services/e2e/e2eService';
import { activateSecurePins, deactivateSecurePins, forgetSecurePins } from '../utils/securePins';

/** A registration the server accepted (202) and mailed a code for. No
 *  account exists yet: `/auth/register/complete` creates it from the code. */
export interface PendingRegistration {
  pendingId: string;
  /** The address as typed, only to name it on the code step */
  email: string;
  /** Seconds after `issuedAt` before the one resend is allowed */
  resendAfterSeconds: number;
  /** Local time (ms) the code was asked for: the resend countdown's anchor */
  issuedAt: number;
  /** The one resend is spent: the code step hides its button */
  resendUsed: boolean;
  /** The completion answered "username taken": the code step asks for
   *  another one and retries with the same code */
  usernameTaken: boolean;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  /** Registration only, deliberately NOT `isSubmitting`.
   *
   *  Before the proof-of-work moved into a worker the solve froze the main
   *  thread, so nobody could leave the register view mid-solve. Now they can —
   *  and a store-wide submitting flag then disables the SIGN IN button on the
   *  login page for the tens of seconds the abandoned solve keeps running,
   *  reading "Signing in…" with Enter inert and no explanation. */
  isRegistering: boolean;
  error: string | null;
  /** Anti-bot proof-of-work progress in [0, 1] while registering, else null.
   *  The solve can run for tens of seconds on a slow device under subnet
   *  pressure, which is far too long for an unexplained disabled button. */
  powProgress: number | null;

  // TOTP login flow
  totpRequired: boolean;
  totpToken: string | null;
  totpRememberMe: boolean;

  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  verifyTOTP: (code: string) => Promise<void>;
  cancelTOTP: () => void;
  /** The verify-first registration, step one: proof of work, then the
   *  request. Creates NO account and signs nobody in: on the server's 202 it
   *  leaves `pendingRegistration` set, and the code step takes over. */
  register: (username: string, email: string, password: string, consent: RegistrationConsent) => Promise<void>;
  /** The registration the server mailed a code for, or null. */
  pendingRegistration: PendingRegistration | null;
  /** Step two: the mailed code (and a new username after a "taken" answer)
   *  creates the account and signs the user in, exactly as a sign-in does. */
  completeRegistration: (code: string, username?: string) => Promise<void>;
  /** The one second code a pending registration may ask for. */
  resendRegistrationCode: () => Promise<void>;
  /** "Start over": abandon the registration for good — stop an in-flight
   *  step and drop the pending code step, so the form comes back. */
  cancelRegistration: () => void;
  /** The registration view was left: stop an in-flight solve (and quiet a
   *  request already sent), but KEEP a pending code step. The server already
   *  mailed its code and spent one of the address's few sign-up mails, and the
   *  code works only with this pending id: coming back to /register shows the
   *  code step again. Memory only — a reload starts over. */
  leaveRegistration: () => void;
  logout: () => void;
  /** The session restore at launch: loads the stored session, verifies it
   *  with `/auth/me`, connects. Single-flight. A transport failure keeps the
   *  tokens and retries on a back-off (`SESSION_RESTORE_RETRY_DELAYS_MS`). */
  checkAuth: () => Promise<void>;
  /** `checkAuth` again, now, when a launch could not reach the server and
   *  kept its tokens (the network came back): a no-op while signed in or
   *  while the first restore is still running. Resets the retry back-off. */
  retrySessionRestore: () => Promise<void>;
  clearError: () => void;
  uploadAvatar: (file: File) => Promise<void>;
  updateProfile: (fields: { displayName?: string; bio?: string }) => Promise<void>;
  forgotPassword: (email: string) => Promise<string>;
  resetPassword: (token: string, password: string) => Promise<string>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<string>;
  resendVerification: () => Promise<void>;
  /** Accept the Terms of Service and the Privacy Policy from an existing
   *  account (one that predates consent-at-signup). Clears the gate the
   *  server holds on every functional route and the socket, then connects. */
  acceptConsent: (consent: RegistrationConsent) => Promise<void>;
  /** Self-service erasure. Re-authenticates with the password (and the TOTP
   *  code when 2FA is on); the server answers 409 with `ownedServers` while
   *  the account still owns any. On success the session is gone server-side
   *  already — this just cleans up locally. */
  deleteAccount: (password: string, totpCode?: string) => Promise<void>;
  setupTOTP: () => Promise<{ secret: string; qrCodeDataUrl: string }>;
  enableTOTP: (code: string) => Promise<string[]>;
  disableTOTP: (code: string) => Promise<void>;
}

/**
 * Before a sign-in or a registration: the tokens of a session this launch
 * could not verify (kept for a retry, see checkAuth) and the socket of a
 * session being replaced must not ride along. The stale token would be sent
 * — and renewed, or refused — on the sign-in request itself, and a socket
 * still open for the old account would be handed to the new one.
 */
function discardStaleSession(): void {
  endSessionRestore();
  // A renewal of the OLD session still in flight must store nothing when it
  // lands — and, refused, must not end the NEW session (the stale session is
  // usually why the user is signing in again)
  endSessionRenewals();
  clearTokens();
  disconnectSocket();
}

/** The restore's own deadline, over the WHOLE attempt — reading the stored
 *  session (a keychain prompt nobody answers), the pre-send renewal and the
 *  `/auth/me` itself: a launch on a half-dead network must reach "could not
 *  restore, retrying" instead of a loading screen forever. */
export const SESSION_RESTORE_TIMEOUT_MS = 15_000;

/** After a restore that did not get an answer (no network, a 5xx, a timeout,
 *  a credential store still starting): the next attempt is this far away,
 *  the last value repeating. A remembered user used to stay on the login
 *  page until the network changed or the next launch. A credential store
 *  that keeps not answering is given the schedule ONCE (a keychain prompt
 *  the user declined must not come back every half minute). */
export const SESSION_RESTORE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

/** The longest a 429's `Retry-After` is honoured for by the restore's retry. */
export const SESSION_RESTORE_RETRY_AFTER_MAX_MS = 300_000;

/** What one restore attempt found; applied only if the session it started for still exists. */
type RestoreOutcome =
  | { kind: 'signed-in'; user: User }
  | { kind: 'no-session'; storeAnswered: boolean }
  | { kind: 'refused' }
  | { kind: 'failed'; message: string; /** A 429's `Retry-After`, when the server named one. */ retryAfterMs?: number };

/** The `Retry-After` of a 429 in milliseconds, bounded; undefined for anything else. */
function retryAfterOf(err: unknown): number | undefined {
  const failed = err as { response?: { status?: unknown; headers?: Record<string, unknown> } } | null;
  if (failed?.response?.status !== 429) return undefined;
  const seconds = Number.parseInt(String(failed.response.headers?.['retry-after'] ?? ''), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, SESSION_RESTORE_RETRY_AFTER_MAX_MS);
}

// Module scope, like the registration abort: live handles, never rendered,
// not part of the reset snapshot
let restoreInFlight: Promise<void> | null = null;
let restoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
let restoreRetryAttempt = 0;
// Bumped by a sign-in, a registration and a logout: a restore started before
// the bump belongs to a session that no longer exists and applies nothing
// (it used to set the OLD user over the new one and hand the old token to
// the socket, or sign a logged-out user back in)
let restoreEpoch = 0;

function cancelRestoreRetry(): void {
  if (restoreRetryTimer !== null) clearTimeout(restoreRetryTimer);
  restoreRetryTimer = null;
  restoreRetryAttempt = 0;
}

/** The session a restore may be running for is gone: its result is void, its retry cancelled. */
function endSessionRestore(): void {
  restoreEpoch++;
  restoreInFlight = null;
  cancelRestoreRetry();
}

/** One pending retry at a time; the delay grows with each failure in a row,
 *  and never undercuts what a 429 asked for (`atLeastMs`): retrying into a
 *  limiter's block only spends the shared budget again. */
function scheduleRestoreRetry(reason: 'server' | 'store', run: () => void, atLeastMs = 0): void {
  if (restoreRetryTimer !== null) return;
  if (reason === 'store' && restoreRetryAttempt >= SESSION_RESTORE_RETRY_DELAYS_MS.length) {
    console.warn('[Auth] The credential store has not answered — the session restore waits for the network to change or the next launch');
    return;
  }
  const delay = Math.max(atLeastMs, SESSION_RESTORE_RETRY_DELAYS_MS[Math.min(restoreRetryAttempt, SESSION_RESTORE_RETRY_DELAYS_MS.length - 1)]);
  restoreRetryAttempt++;
  restoreRetryTimer = setTimeout(() => {
    restoreRetryTimer = null;
    run();
  }, delay);
}

/** `work`, or `onTimeout()` when it has not settled within `ms`. A rejection counts as settled. */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T, onError: (err: unknown) => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); resolve(onError(err)); },
    );
  });
}

/** One restore attempt, side-effect free: what it found is applied by the caller, if still wanted. */
async function attemptRestore(): Promise<RestoreOutcome> {
  // The stored session is read from the OS credential store in the desktop
  // app (asynchronous IPC): nothing is known before this answers
  const storeAnswered = await hydrateTokens();
  if (!getAccessToken()) return { kind: 'no-session', storeAnswered };
  try {
    const { data } = await api.get('/auth/me', { timeout: SESSION_RESTORE_TIMEOUT_MS });
    return { kind: 'signed-in', user: data.data as User };
  } catch (err) {
    if (isAuthRefusal(err)) return { kind: 'refused' };
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err), retryAfterMs: retryAfterOf(err) };
  }
}

/** @internal tests */
export function _resetSessionRestoreForTests(): void {
  endSessionRestore();
}

/**
 * Fetch a proof-of-work challenge and solve it, retrying ONCE with a fresh
 * challenge if the first one expires mid-solve. Solve time is geometric, so a
 * small tail of honest attempts overruns the window on a slow device even at
 * the difficulty ceiling; one retry turns that dead end into a slower success.
 * Exactly one retry — an unbounded loop on a device too slow for the issued
 * difficulty would grind forever instead of surfacing the failure.
 */
async function solveWithRetry(onProgress: (fraction: number) => void, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new PowAbortedError();
    const { data: challengeRes } = await api.get('/auth/register-challenge');
    try {
      return await solveRegistrationPowOffThread(challengeRes.data, onProgress, signal);
    } catch (err) {
      if (attempt >= 1 || !(err instanceof PowExpiredError)) throw err;
      console.warn('[PoW] Challenge expired mid-solve — retrying with a fresh one');
      onProgress(0);
    }
  }
}

/** Can this account hold a live session? The socket auth refuses BOTH an
 *  unverified email and an account that has not accepted the legal
 *  documents; connecting anyway only produces a reconnect loop. */
function canConnect(user: { emailVerified: boolean; consentRequired?: boolean }): boolean {
  return user.emailVerified && !user.consentRequired;
}

/** The server REFUSED the session (401/403), or the renewal was refused for
 *  good (SessionLostError): as opposed to a request that never reached it.
 *  A 401 to a request that went out with a token the client KNEW was expired
 *  — its pre-send renewal had just failed transiently (`_renewalFailed`:
 *  a 429 from the refresh limiter, a 5xx, a timeout) — answers that stale
 *  token, not the session: the refresh token was never judged. */
function isAuthRefusal(err: unknown): boolean {
  if (err instanceof SessionLostError) return true;
  const failed = err as { response?: { status?: unknown }; config?: SessionRequestConfig } | null;
  const status = failed?.response?.status;
  if (status === 401 && failed?.config?._renewalFailed) return false;
  return status === 401 || status === 403;
}

/** The in-flight registration's abort handle. Module scope, not store state:
 *  it is a live object, never rendered, and must not be part of the reset
 *  snapshot `resetAccountStores` captures. */
let registrationAbort: AbortController | null = null;

/** A 2xx registration answer without the pending id the code step needs:
 *  shown as the generic failure, never as its own (English) message. */
class RegistrationAnswerError extends Error {}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  isSubmitting: false,
  isRegistering: false,
  error: null,
  powProgress: null,
  pendingRegistration: null,
  totpRequired: false,
  totpToken: null,
  totpRememberMe: true,

  login: async (email, password, rememberMe = true) => {
    set({ isSubmitting: true, error: null });
    discardStaleSession();
    try {
      const trustedDeviceToken = getTrustedDeviceToken() || undefined;
      const { data } = await api.post('/auth/login', { email, password, rememberMe, trustedDeviceToken });

      // If TOTP is required, pause login flow
      if (data.data.totpRequired) {
        set({ totpRequired: true, totpToken: data.data.totpToken, totpRememberMe: rememberMe, isSubmitting: false });
        return;
      }

      const { user, accessToken, refreshToken } = data.data;
      setTokens(accessToken, refreshToken, rememberMe);
      if (canConnect(user)) {
        connectSocket(accessToken);
      }
      // A sign-in ends any sign-up left pending on this machine: its typed
      // address must not wait on the register page for the next person
      set({ user, isAuthenticated: true, isSubmitting: false, pendingRegistration: null });
    } catch (err) {
      set({
        error: getTranslatedError(err, i18n.t, 'auth.login.loginFailed'),
        isSubmitting: false,
      });
      throw err;
    }
  },

  verifyTOTP: async (code) => {
    const { totpToken, totpRememberMe } = get();
    if (!totpToken) return;
    set({ isSubmitting: true, error: null });
    try {
      const { data } = await api.post('/auth/totp/verify', { totpToken, code });
      const { user, accessToken, refreshToken, trustedDeviceToken } = data.data;
      setTokens(accessToken, refreshToken, totpRememberMe);
      if (trustedDeviceToken) {
        setTrustedDeviceToken(trustedDeviceToken);
      }
      if (canConnect(user)) {
        connectSocket(accessToken);
      }
      set({
        user, isAuthenticated: true, isSubmitting: false, totpRequired: false, totpToken: null, totpRememberMe: true,
        pendingRegistration: null,
      });
    } catch (err) {
      set({
        error: getTranslatedError(err, i18n.t, 'settings.security.invalidCode'),
        isSubmitting: false,
      });
      throw err;
    }
  },

  cancelTOTP: () => {
    set({ totpRequired: false, totpToken: null, totpRememberMe: true, error: null });
  },

  register: async (username, email, password, consent) => {
    registrationAbort?.abort();
    const controller = new AbortController();
    registrationAbort = controller;
    set({ isRegistering: true, error: null, powProgress: 0, pendingRegistration: null });
    discardStaleSession();
    try {
      // Anti-bot proof-of-work: fetch a challenge and burn CPU solving it. No
      // captcha, no third-party service, nothing leaves our infrastructure.
      // Solved in a worker so the page stays interactive, with progress shown
      // — under subnet pressure this is tens of seconds, not a blink.
      const pow = await solveWithRetry((fraction) => set({ powProgress: fraction }), controller.signal);
      if (controller.signal.aborted) throw new PowAbortedError();

      const { data } = await api.post('/auth/register', { username, email, password, pow, ...consent });
      // Once sent, the start is kept even when the view was left meanwhile:
      // the server mailed a code that works only with this pending id, so
      // coming back to /register finds the code step. Unless someone signed
      // in since — their session never carries another person's sign-up — or
      // a newer attempt replaced this one.
      if (controller.signal.aborted && (get().isAuthenticated || registrationAbort !== null)) {
        throw new PowAbortedError();
      }
      const answer = (data?.data ?? {}) as { pendingId?: unknown; resendAfterSeconds?: unknown };
      if (typeof answer.pendingId !== 'string' || answer.pendingId.length === 0) {
        throw new RegistrationAnswerError('Registration answer carried no pending id');
      }
      const resendAfterSeconds = typeof answer.resendAfterSeconds === 'number' && Number.isFinite(answer.resendAfterSeconds) && answer.resendAfterSeconds >= 0
        ? answer.resendAfterSeconds
        : SIGNUP.RESEND_AFTER_SECONDS;

      set({
        pendingRegistration: {
          pendingId: answer.pendingId,
          email,
          resendAfterSeconds,
          issuedAt: Date.now(),
          resendUsed: false,
          usernameTaken: false,
        },
        isRegistering: false,
        powProgress: null,
      });
    } catch (err) {
      // An abandoned solve is not a failure to report — the view is gone and
      // `leaveRegistration` already cleared the flags. The same goes for a
      // POST that was already in flight when the view was left: the store's
      // `error` is shared with LoginPage, which would render a 409 from this
      // abandoned registration as a failed login the user never attempted.
      if (err instanceof PowAbortedError) throw err;
      if (controller.signal.aborted) throw new PowAbortedError();
      set({
        error: err instanceof RegistrationAnswerError
          ? i18n.t('auth.register.registrationFailed')
          : getTranslatedError(err, i18n.t, 'auth.register.registrationFailed'),
        isRegistering: false,
        powProgress: null,
      });
      throw err;
    } finally {
      if (registrationAbort === controller) registrationAbort = null;
    }
  },

  completeRegistration: async (code, username) => {
    const pending = get().pendingRegistration;
    if (!pending) return;
    registrationAbort?.abort();
    const controller = new AbortController();
    registrationAbort = controller;
    set({ isRegistering: true, error: null });
    // The answer is a sign-in: whatever this launch kept of an older session
    // must not ride along on it, nor be renewed over the new one
    discardStaleSession();
    try {
      const body: { pendingId: string; code: string; username?: string } = { pendingId: pending.pendingId, code };
      if (username !== undefined) body.username = username;
      const { data } = await api.post('/auth/register/complete', body);
      const { user, accessToken, refreshToken } = data.data;

      // The account now EXISTS, so there is nothing left to abandon: finish the
      // sign-in even if the view was left in the meantime, rather than stranding
      // someone with credentials they were never told about — UNLESS the user
      // already signed in as someone else while this POST was in flight. The
      // abandoned registration must not silently swap their session for the
      // account they walked away from; they can sign in to it deliberately.
      const current = get();
      if (controller.signal.aborted && current.isAuthenticated && current.user && current.user.id !== user.id) {
        return;
      }
      setTokens(accessToken, refreshToken, true);

      // The code proved the mailbox and the consent travelled with step one,
      // but the socket still waits for whatever the server says is missing
      if (canConnect(user)) {
        connectSocket(accessToken);
      }

      set({ user, isAuthenticated: true, isRegistering: false, pendingRegistration: null });
    } catch (err) {
      // A view left mid-request: `error` is shared with LoginPage, which would
      // show this abandoned step's answer as a failed sign-in
      if (controller.signal.aborted) throw err;
      const serverMessage = (err as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
      const latest = get().pendingRegistration;
      set({
        error: getTranslatedError(err, i18n.t, 'auth.register.registrationFailed'),
        isRegistering: false,
        // A taken username costs no attempt: the same code goes again with
        // another name, so the code step asks for one
        ...(serverMessage === USERNAME_TAKEN_MESSAGE && latest && latest.pendingId === pending.pendingId
          ? { pendingRegistration: { ...latest, usernameTaken: true } }
          : {}),
      });
      throw err;
    } finally {
      if (registrationAbort === controller) registrationAbort = null;
    }
  },

  resendRegistrationCode: async () => {
    const pending = get().pendingRegistration;
    if (!pending || pending.resendUsed) return;
    registrationAbort?.abort();
    const controller = new AbortController();
    registrationAbort = controller;
    set({ error: null });
    try {
      await api.post('/auth/register/resend', { pendingId: pending.pendingId });
      const latest = get().pendingRegistration;
      if (latest && latest.pendingId === pending.pendingId) {
        set({ pendingRegistration: { ...latest, resendUsed: true } });
      }
    } catch (err) {
      // Only a limiter or the network refuses it (the route always answers
      // 202): the button stays, and the reason shows
      console.warn('[Auth] Sign-up code resend failed:', err instanceof Error ? err.message : err);
      // A view left meanwhile: `error` is shared with LoginPage
      if (!controller.signal.aborted && get().pendingRegistration?.pendingId === pending.pendingId) {
        set({ error: getTranslatedError(err, i18n.t, 'auth.register.code.resendFailed') });
      }
      throw err;
    } finally {
      if (registrationAbort === controller) registrationAbort = null;
    }
  },

  cancelRegistration: () => {
    registrationAbort?.abort();
    registrationAbort = null;
    // The code step's refusal must not follow the user anywhere
    set({ isRegistering: false, powProgress: null, pendingRegistration: null, error: null });
  },

  leaveRegistration: () => {
    registrationAbort?.abort();
    registrationAbort = null;
    // `error` is shared with LoginPage, where the code step's last refusal
    // ("Invalid or expired code") would read as a failed sign-in
    set({ isRegistering: false, powProgress: null, error: null });
  },

  logout: () => {
    // Clean up voice state before disconnecting socket (stops mic, audio pipeline)
    const vs = useVoiceStore.getState();
    if (vs.activeChannelId) vs.leaveChannel();
    if (vs.dmCallConversationId) vs.leaveDMCall();

    // A token renewal still in flight must not store its answer after this:
    // it would be the logged-out user's session, with a socket opened for it
    endSessionRenewals();
    // ... and a session restore in flight (one the email-verification page
    // started, a retry) must not sign the logged-out user back in
    endSessionRestore();
    clearTokens();
    disconnectSocket();
    // Wipe every account-scoped store — on a shared machine the next login must
    // never see the previous account's servers, DMs, or support transcript
    resetAccountStores();
    set({ user: null, isAuthenticated: false, pendingRegistration: null });
  },

  retrySessionRestore: async () => {
    const { isAuthenticated, isLoading, checkAuth } = get();
    if (isAuthenticated || isLoading) return;
    // The network came back: now, not at the end of the current back-off
    cancelRestoreRetry();
    await checkAuth();
  },

  checkAuth: () => {
    // Single-flight: the launch, the network coming back and a retry timer
    // can ask within the same second, and two `/auth/me` would renew twice
    if (restoreInFlight) return restoreInFlight;
    const epoch = restoreEpoch;
    const retry = () => {
      if (!get().isAuthenticated) void get().checkAuth();
    };
    const run = (async () => {
      const outcome = await withDeadline<RestoreOutcome>(
        attemptRestore(),
        SESSION_RESTORE_TIMEOUT_MS,
        () => ({ kind: 'failed', message: `no answer within ${SESSION_RESTORE_TIMEOUT_MS} ms` }),
        (err) => ({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }),
      );
      // Signed in as someone else, or out, while this ran: the answer is
      // about a session that no longer exists
      if (epoch !== restoreEpoch) {
        set({ isLoading: false });
        return;
      }
      switch (outcome.kind) {
        case 'signed-in': {
          cancelRestoreRetry();
          // The CURRENT token, not one read before the call: `/auth/me` may
          // have renewed it (an app launched after its access token expired),
          // and a handshake with the old one is refused and waits a back-off
          const token = getAccessToken();
          if (token && canConnect(outcome.user)) connectSocket(token);
          set({ user: outcome.user, isAuthenticated: true, isLoading: false });
          break;
        }
        case 'no-session':
          // Nothing to restore — unless the store did not answer (a keyring
          // daemon still starting at login): then it is asked again shortly
          if (!outcome.storeAnswered && !get().isAuthenticated) scheduleRestoreRetry('store', retry);
          set({ isLoading: false });
          break;
        case 'refused':
          // The one case that ends the session (a refused renewal has
          // cleared the tokens already)
          cancelRestoreRetry();
          clearTokens();
          set({ isLoading: false });
          break;
        case 'failed':
          // A launch with no network, a server mid-restart, a deadline: the
          // tokens stay and the restore runs again on a back-off — the user
          // signs back in without a password the moment the server answers
          console.warn('[Auth] Session restore could not reach the server (tokens kept, retrying):', outcome.message);
          if (!get().isAuthenticated) scheduleRestoreRetry('server', retry, outcome.retryAfterMs ?? 0);
          set({ isLoading: false });
          break;
      }
    })().finally(() => {
      if (restoreInFlight === run) restoreInFlight = null;
    });
    restoreInFlight = run;
    return run;
  },

  clearError: () => set({ error: null }),

  uploadAvatar: async (file: File) => {
    // 1. Get presigned PUT URL
    const { data: presignData } = await api.post('/uploads/presign/avatar');
    const { uploadUrl, key } = presignData.data;

    // 2. Client-side resize + WebP conversion
    const blob = await processImage(file);

    // 3. Direct upload to S3
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'image/webp' },
    });
    if (!uploadRes.ok) {
      throw new Error(`S3 upload failed: ${uploadRes.status}`);
    }

    // 4. Confirm in DB (triggers old avatar cleanup + socket broadcast)
    await api.patch('/users/me/profile', { avatarUrl: key });

    // 5. Optimistic local state update + cross-store propagation
    const userId = get().user?.id;
    set((state) => ({
      user: state.user ? { ...state.user, avatarUrl: key } : null,
    }));
    if (userId) {
      useServerStore.getState().updateMemberAvatar(userId, key);
      useChatStore.getState().updateAuthorAvatar(userId, key);
    }
  },

  updateProfile: async (fields) => {
    const { data } = await api.patch('/users/me/profile', fields);
    set((state) => ({ user: state.user ? { ...state.user, ...data.data } : null }));
  },

  forgotPassword: async (email) => {
    const { data } = await api.post('/auth/forgot-password', { email });
    return data.message;
  },

  resetPassword: async (token, password) => {
    const { data } = await api.post('/auth/reset-password', { token, password });
    return data.message;
  },

  changePassword: async (currentPassword, newPassword) => {
    const { data } = await api.post('/auth/change-password', { currentPassword, newPassword, rememberMe: isRemembered() });
    // Store fresh tokens so the current session survives the tokenVersion bump
    if (data.data?.accessToken && data.data?.refreshToken) {
      setTokens(data.data.accessToken, data.data.refreshToken);
    }
    return data.message;
  },

  deleteAccount: async (password, totpCode) => {
    const userId = get().user?.id;
    await api.delete('/auth/account', { data: { password, ...(totpCode ? { totpCode } : {}) } });
    // The server has purged the account and disconnected its sockets; what is
    // left is this device's copy of it. Same cleanup as logout, plus the E2E
    // vault logout deliberately keeps — every key it pairs with is gone.
    get().logout();
    if (userId) {
      forgetLocalE2EState(userId);
      // The secure-channel pins pair with the same vanished account.
      forgetSecurePins(userId);
    }
    clearTrustedDeviceToken();
  },

  acceptConsent: async (consent) => {
    await api.post('/auth/consent', consent);
    const user = get().user;
    if (!user) return;
    const updated = { ...user, consentRequired: false };
    set({ user: updated });
    const token = getAccessToken();
    if (token && canConnect(updated)) connectSocket(token);
  },

  resendVerification: async () => {
    await api.post('/auth/resend-verification');
  },

  setupTOTP: async () => {
    const { data } = await api.post('/auth/totp/setup');
    return data.data;
  },

  enableTOTP: async (code) => {
    const { data } = await api.post('/auth/totp/enable', { code });
    // Update local user state
    set((state) => ({ user: state.user ? { ...state.user, totpEnabled: true } : null }));
    return data.data.backupCodes;
  },

  disableTOTP: async (code) => {
    await api.post('/auth/totp/disable', { code });
    clearTrustedDeviceToken();
    set((state) => ({ user: state.user ? { ...state.user, totpEnabled: false } : null }));
  },
}));

// Secure-channel pins (utils/securePins.ts) follow the signed-in account. One
// subscription instead of a call per login path (password, TOTP, register,
// session restore): every path ends in `set({ user })`, synchronously, before
// any socket event or channel fetch can land — so no channel list is ever
// normalised against the wrong account (or none). Logout only deactivates;
// the pins stay for the same account's next login.
useAuthStore.subscribe((state, prev) => {
  const id = state.user?.id ?? null;
  if (id === (prev.user?.id ?? null)) return;
  if (id) activateSecurePins(id);
  else deactivateSecurePins();
});

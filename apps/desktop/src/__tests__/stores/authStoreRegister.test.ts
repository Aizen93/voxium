import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import {
  PowAbortedError, SIGNUP, USERNAME_TAKEN_MESSAGE, SIGNUP_CODE_INVALID_MESSAGE, SIGNUP_EMAIL_REGISTERED_MESSAGE,
} from '@voxium/shared';
import type { PendingRegistration } from '../../stores/authStore';

// Moving the proof-of-work into a worker made the register view navigable
// mid-solve for the first time. Two things follow from that, and neither is
// visible from the solver's own tests:
//   1. the submitting flag can no longer be shared with the login page, and
//   2. walking away has to actually STOP the flow — otherwise the abandoned
//      solve completes, POSTs, and signs the user in to an account they left.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));

const solver = vi.hoisted(() => ({ solveRegistrationPowOffThread: vi.fn() }));
vi.mock('../../services/powSolver', () => solver);

// voiceStore registers a reconnect handler at module import, and authStore
// imports it — so the socket module has to be mocked whole, not partially.
const socket = vi.hoisted(() => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn() }));
vi.mock('../../services/socket', () => ({
  connectSocket: socket.connectSocket,
  disconnectSocket: socket.disconnectSocket,
  getSocket: vi.fn(() => null),
  getSocketGeneration: vi.fn(() => 0),
  onSocketReady: vi.fn(() => () => {}),
  onSocketReconnect: vi.fn(() => () => {}),
  onConnectionStatusChange: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => 'connected'),
}));
const storage = vi.hoisted(() => ({ setTokens: vi.fn(), clearTokens: vi.fn() }));
vi.mock('../../services/tokenStorage', () => ({
  getAccessToken: vi.fn(() => null),
  setTokens: storage.setTokens,
  clearTokens: storage.clearTokens,
  isRemembered: vi.fn(() => true),
  hydrateTokens: vi.fn(async () => true),
  getTrustedDeviceToken: vi.fn(() => null),
  setTrustedDeviceToken: vi.fn(),
  clearTrustedDeviceToken: vi.fn(),
}));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import { useAuthStore } from '../../stores/authStore';

const CHALLENGE = { challenge: 'a'.repeat(32), difficulty: 1, expires: Date.now() + 60_000, sig: 'f'.repeat(64) };
const CONSENT = { acceptTerms: true, acceptPrivacy: true };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: { data: CHALLENGE } });
  useAuthStore.setState({
    user: null, isAuthenticated: false, isSubmitting: false, isRegistering: false,
    error: null, powProgress: null, pendingRegistration: null,
  });
});

function pendingState(over: Partial<PendingRegistration> = {}): PendingRegistration {
  return {
    pendingId: 'p1', email: 'a@example.com', resendAfterSeconds: 600, issuedAt: Date.now(),
    resendUsed: false, usernameTaken: false, ...over,
  };
}

/** An HTTP refusal carrying the server's English sentence, as axios builds it. */
function axiosError(status: number, message: string) {
  return new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, {
    status, data: { success: false, error: message },
  } as never);
}

/** A POST that settles only when the test says so. */
function hangingPost() {
  let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  api.post.mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));
  return () => settle;
}

/** A solve that never finishes on its own, but honours the abort signal. */
function hangingSolve() {
  solver.solveRegistrationPowOffThread.mockImplementation(
    (_challenge: unknown, _onProgress: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new PowAbortedError()), { once: true });
      }),
  );
}

describe('authStore.register — proof-of-work flow', () => {
  it('does NOT set the shared isSubmitting flag, so the login page stays usable', async () => {
    hangingSolve();
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
    await vi.waitFor(() => expect(useAuthStore.getState().isRegistering).toBe(true));

    // LoginPage's submit button is gated on isSubmitting. If registration set
    // it, "Sign in" would read "Signing in…" and refuse clicks for the whole
    // solve — tens of seconds under subnet pressure, with Enter inert too.
    expect(useAuthStore.getState().isSubmitting).toBe(false);

    useAuthStore.getState().cancelRegistration();
    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
  });

  it('cancelRegistration aborts the solve and never creates the account', async () => {
    hangingSolve();
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
    await vi.waitFor(() => expect(useAuthStore.getState().isRegistering).toBe(true));

    useAuthStore.getState().cancelRegistration();
    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);

    // The whole point: no POST, so no account and no session
    expect(api.post).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().isRegistering).toBe(false);
    expect(useAuthStore.getState().powProgress).toBeNull();
  });

  it('does not surface an abandoned solve as a registration error', async () => {
    // The view is gone; an error toast on the page they navigated TO would be
    // the app blaming them for leaving.
    hangingSolve();
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
    await vi.waitFor(() => expect(useAuthStore.getState().isRegistering).toBe(true));

    useAuthStore.getState().cancelRegistration();
    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);

    expect(useAuthStore.getState().error).toBeNull();
  });

  it('passes an abort signal through to the solver', async () => {
    hangingSolve();
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
    await vi.waitFor(() => expect(solver.solveRegistrationPowOffThread).toHaveBeenCalled());

    const signal = solver.solveRegistrationPowOffThread.mock.calls[0][2] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    useAuthStore.getState().cancelRegistration();
    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
  });

  it('a 202 leaves the pending registration for the code step and signs nobody in', async () => {
    solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
    api.post.mockResolvedValue({ data: { success: true, data: { pendingId: 'p1', resendAfterSeconds: 600 } } });

    const before = Date.now();
    await useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);

    // Consent travels with the POST — the server refuses a registration without it
    expect(api.post).toHaveBeenCalledWith('/auth/register', expect.objectContaining({ username: 'alice', acceptTerms: true, acceptPrivacy: true }));
    const s = useAuthStore.getState();
    expect(s.pendingRegistration).toMatchObject({ pendingId: 'p1', email: 'a@example.com', resendAfterSeconds: 600, resendUsed: false, usernameTaken: false });
    expect(s.pendingRegistration!.issuedAt).toBeGreaterThanOrEqual(before);
    // No account exists yet: no session, no tokens, no socket
    expect(s.isAuthenticated).toBe(false);
    expect(s.user).toBeNull();
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(s.isRegistering).toBe(false);
    expect(s.powProgress).toBeNull();
    expect(s.isSubmitting).toBe(false);
  });

  it('falls back to the shared resend delay when the answer carries none', async () => {
    solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
    api.post.mockResolvedValue({ data: { data: { pendingId: 'p1' } } });
    await useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
    expect(useAuthStore.getState().pendingRegistration?.resendAfterSeconds).toBe(SIGNUP.RESEND_AFTER_SECONDS);
  });

  it('an answer without a pending id is a generic failure, never a code step', async () => {
    solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
    api.post.mockResolvedValue({ data: { data: {} } });
    await expect(useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT)).rejects.toBeTruthy();
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
    expect(useAuthStore.getState().error).toBe('auth.register.registrationFailed');
    expect(useAuthStore.getState().isRegistering).toBe(false);
  });

  it('a taken username at the start is the translated error, and no code step', async () => {
    solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
    api.post.mockRejectedValue(axiosError(409, USERNAME_TAKEN_MESSAGE));
    await expect(useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT)).rejects.toBeTruthy();
    expect(useAuthStore.getState().error).toBe('serverErrors.usernameTaken');
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
  });

  // The solve is abortable; the POST that follows it is not. Walking away
  // while it is in flight must not leak a refusal onto whatever page the user
  // went to (`error` is shared with LoginPage) — but an accepted start is
  // kept: its code is already in the mailbox, bound to this pending id.
  describe('leaving the view while the POST is in flight', () => {
    it('does not surface a 409 from the abandoned registration as an error on the next page', async () => {
      solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
      const post = hangingPost();

      const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
      await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
      useAuthStore.getState().leaveRegistration(); // RegisterPage unmounted → LoginPage mounted, clearError ran
      post().reject(axiosError(409, USERNAME_TAKEN_MESSAGE));

      await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
      expect(useAuthStore.getState().error).toBeNull();
      expect(useAuthStore.getState().isRegistering).toBe(false);
    });

    it('a 202 that lands after the view was left still stores the code step', async () => {
      solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
      const post = hangingPost();

      const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
      await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
      useAuthStore.getState().leaveRegistration();
      post().resolve({ data: { data: { pendingId: 'p1', resendAfterSeconds: 600 } } });

      await pending;
      expect(useAuthStore.getState().pendingRegistration).toMatchObject({ pendingId: 'p1', email: 'a@example.com' });
      expect(useAuthStore.getState().isRegistering).toBe(false);
      expect(useAuthStore.getState().error).toBeNull();
    });

    it('a 202 that lands after someone signed in is dropped', async () => {
      solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
      const post = hangingPost();

      const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
      await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
      useAuthStore.getState().leaveRegistration();
      useAuthStore.setState({ user: { id: 'u-existing' } as never, isAuthenticated: true });
      post().resolve({ data: { data: { pendingId: 'p1', resendAfterSeconds: 600 } } });

      await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
      expect(useAuthStore.getState().pendingRegistration).toBeNull();
    });

    it('a 202 for an attempt a newer one replaced is dropped', async () => {
      solver.solveRegistrationPowOffThread.mockResolvedValueOnce({ ...CHALLENGE, nonce: '3' });
      const post = hangingPost();
      const first = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
      await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
      const firstPost = post();

      hangingSolve();
      const second = useAuthStore.getState().register('alice', 'b@example.com', 'password123', CONSENT);
      firstPost.resolve({ data: { data: { pendingId: 'old', resendAfterSeconds: 600 } } });

      await expect(first).rejects.toBeInstanceOf(PowAbortedError);
      expect(useAuthStore.getState().pendingRegistration).toBeNull();
      expect(useAuthStore.getState().isRegistering).toBe(true);
      useAuthStore.getState().cancelRegistration();
      await expect(second).rejects.toBeInstanceOf(PowAbortedError);
    });
  });

  it('leaving the view mid-solve stops the solve and never posts', async () => {
    hangingSolve();
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
    await vi.waitFor(() => expect(solver.solveRegistrationPowOffThread).toHaveBeenCalled());
    useAuthStore.getState().leaveRegistration();
    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
    expect(api.post).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isRegistering).toBe(false);
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('a new registration replaces an older pending one', async () => {
    useAuthStore.setState({ pendingRegistration: pendingState({ pendingId: 'old' }) });
    hangingSolve();
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123', CONSENT);
    await vi.waitFor(() => expect(useAuthStore.getState().isRegistering).toBe(true));
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
    useAuthStore.getState().cancelRegistration();
    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
  });
});

describe('authStore.completeRegistration — the code creates the account', () => {
  const user = { id: 'u-new', username: 'alice', emailVerified: true };

  beforeEach(() => {
    useAuthStore.setState({ pendingRegistration: pendingState() });
  });

  it('posts the pending id and the code, then signs in exactly as a sign-in does', async () => {
    api.post.mockResolvedValue({ data: { data: { user, accessToken: 'at', refreshToken: 'rt' } } });

    await useAuthStore.getState().completeRegistration('123456');

    expect(api.post).toHaveBeenCalledWith('/auth/register/complete', { pendingId: 'p1', code: '123456' });
    // The stale session of this launch is dropped BEFORE the request goes out
    expect(storage.clearTokens.mock.invocationCallOrder[0]).toBeLessThan(api.post.mock.invocationCallOrder[0]);
    expect(socket.disconnectSocket.mock.invocationCallOrder[0]).toBeLessThan(api.post.mock.invocationCallOrder[0]);
    expect(storage.setTokens).toHaveBeenCalledWith('at', 'rt', true);
    expect(socket.connectSocket).toHaveBeenCalledWith('at');
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.user?.id).toBe('u-new');
    expect(s.pendingRegistration).toBeNull();
    expect(s.isRegistering).toBe(false);
    expect(s.error).toBeNull();
  });

  it('sends the new username when one is given', async () => {
    api.post.mockResolvedValue({ data: { data: { user, accessToken: 'at', refreshToken: 'rt' } } });
    await useAuthStore.getState().completeRegistration('123456', 'alice2');
    expect(api.post).toHaveBeenCalledWith('/auth/register/complete', { pendingId: 'p1', code: '123456', username: 'alice2' });
  });

  it('does not connect the socket for an account the server still gates (consent missing)', async () => {
    api.post.mockResolvedValue({ data: { data: { user: { ...user, consentRequired: true }, accessToken: 'at', refreshToken: 'rt' } } });
    await useAuthStore.getState().completeRegistration('123456');
    expect(storage.setTokens).toHaveBeenCalledWith('at', 'rt', true);
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('a refused code keeps the code step with the translated error', async () => {
    api.post.mockRejectedValue(axiosError(400, SIGNUP_CODE_INVALID_MESSAGE));
    await expect(useAuthStore.getState().completeRegistration('000000')).rejects.toBeTruthy();
    const s = useAuthStore.getState();
    expect(s.error).toBe('serverErrors.signupCodeInvalid');
    expect(s.pendingRegistration).toMatchObject({ pendingId: 'p1', usernameTaken: false });
    expect(s.isAuthenticated).toBe(false);
    expect(s.isRegistering).toBe(false);
    expect(storage.setTokens).not.toHaveBeenCalled();
  });

  it('a taken username flags the code step to ask for another one', async () => {
    api.post.mockRejectedValue(axiosError(409, USERNAME_TAKEN_MESSAGE));
    await expect(useAuthStore.getState().completeRegistration('123456')).rejects.toBeTruthy();
    expect(useAuthStore.getState().pendingRegistration?.usernameTaken).toBe(true);
    expect(useAuthStore.getState().error).toBe('serverErrors.usernameTaken');
  });

  it('an address that already has an account answers with its own message', async () => {
    api.post.mockRejectedValue(axiosError(409, SIGNUP_EMAIL_REGISTERED_MESSAGE));
    await expect(useAuthStore.getState().completeRegistration('123456')).rejects.toBeTruthy();
    expect(useAuthStore.getState().error).toBe('serverErrors.signupEmailRegistered');
    expect(useAuthStore.getState().pendingRegistration?.usernameTaken).toBe(false);
  });

  it('does nothing without a pending registration', async () => {
    useAuthStore.setState({ pendingRegistration: null });
    await useAuthStore.getState().completeRegistration('123456');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a view left mid-request reports nothing on the next page', async () => {
    const post = hangingPost();
    const pending = useAuthStore.getState().completeRegistration('000000');
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
    useAuthStore.getState().leaveRegistration();
    post().reject(axiosError(400, SIGNUP_CODE_INVALID_MESSAGE));
    await expect(pending).rejects.toBeTruthy();
    expect(useAuthStore.getState().error).toBeNull();
    // ... and the code step is still there to come back to
    expect(useAuthStore.getState().pendingRegistration?.pendingId).toBe('p1');
  });

  it('still finishes the sign-in when the view was left — the account exists now', async () => {
    const post = hangingPost();
    const pending = useAuthStore.getState().completeRegistration('123456');
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
    useAuthStore.getState().leaveRegistration();
    post().resolve({ data: { data: { user, accessToken: 'at', refreshToken: 'rt' } } });
    await pending;
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user?.id).toBe('u-new');
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
  });

  it('does NOT replace a session the user established as someone else meanwhile', async () => {
    const post = hangingPost();
    const pending = useAuthStore.getState().completeRegistration('123456');
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
    useAuthStore.getState().leaveRegistration();
    useAuthStore.setState({ user: { id: 'u-existing' } as never, isAuthenticated: true });
    post().resolve({ data: { data: { user, accessToken: 'at', refreshToken: 'rt' } } });
    await pending;
    expect(useAuthStore.getState().user?.id).toBe('u-existing');
    expect(storage.setTokens).not.toHaveBeenCalled();
  });
});

describe('authStore.resendRegistrationCode — one more code', () => {
  beforeEach(() => {
    useAuthStore.setState({ pendingRegistration: pendingState() });
  });

  it('posts the pending id and marks the one resend as spent', async () => {
    api.post.mockResolvedValue({ data: { data: { pendingId: 'p1', resendAfterSeconds: 600 } } });
    await useAuthStore.getState().resendRegistrationCode();
    expect(api.post).toHaveBeenCalledWith('/auth/register/resend', { pendingId: 'p1' });
    expect(useAuthStore.getState().pendingRegistration?.resendUsed).toBe(true);
  });

  it('never asks twice', async () => {
    useAuthStore.setState({ pendingRegistration: pendingState({ resendUsed: true }) });
    await useAuthStore.getState().resendRegistrationCode();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a refused resend keeps the button and shows why', async () => {
    api.post.mockRejectedValue(axiosError(429, 'Too many requests. Please try again later.'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(useAuthStore.getState().resendRegistrationCode()).rejects.toBeTruthy();
    expect(useAuthStore.getState().pendingRegistration?.resendUsed).toBe(false);
    expect(useAuthStore.getState().error).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing without a pending registration', async () => {
    useAuthStore.setState({ pendingRegistration: null });
    await useAuthStore.getState().resendRegistrationCode();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a resend refused after the view was left reports nothing on the next page', async () => {
    const post = hangingPost();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = useAuthStore.getState().resendRegistrationCode();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
    useAuthStore.getState().leaveRegistration();
    post().reject(axiosError(429, 'Too many requests. Please try again later.'));
    await expect(pending).rejects.toBeTruthy();
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().pendingRegistration?.pendingId).toBe('p1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a resend accepted after the view was left still marks the resend as spent', async () => {
    const post = hangingPost();
    const pending = useAuthStore.getState().resendRegistrationCode();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
    useAuthStore.getState().leaveRegistration();
    post().resolve({ data: { data: { pendingId: 'p1', resendAfterSeconds: 600 } } });
    await pending;
    expect(useAuthStore.getState().pendingRegistration?.resendUsed).toBe(true);
  });
});

describe('authStore — leaving the registration', () => {
  it('cancelRegistration ("Start over") drops the code step and its error', () => {
    useAuthStore.setState({ pendingRegistration: pendingState(), error: 'serverErrors.signupCodeInvalid' });
    useAuthStore.getState().cancelRegistration();
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('leaveRegistration keeps the code step and clears its error', () => {
    useAuthStore.setState({ pendingRegistration: pendingState(), error: 'serverErrors.signupCodeInvalid', isRegistering: true });
    useAuthStore.getState().leaveRegistration();
    expect(useAuthStore.getState().pendingRegistration?.pendingId).toBe('p1');
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().isRegistering).toBe(false);
  });

  it('a sign-in clears a sign-up left pending on this machine', async () => {
    useAuthStore.setState({ pendingRegistration: pendingState() });
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u1', emailVerified: true }, accessToken: 'at', refreshToken: 'rt' } } });
    await useAuthStore.getState().login('b@example.com', 'password123');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
  });

  it('a sign-in paused for TOTP keeps the pending sign-up until the code is accepted', async () => {
    useAuthStore.setState({ pendingRegistration: pendingState() });
    api.post.mockResolvedValueOnce({ data: { data: { totpRequired: true, totpToken: 'tt' } } });
    await useAuthStore.getState().login('b@example.com', 'password123');
    expect(useAuthStore.getState().pendingRegistration?.pendingId).toBe('p1');

    api.post.mockResolvedValueOnce({ data: { data: { user: { id: 'u1', emailVerified: true }, accessToken: 'at', refreshToken: 'rt' } } });
    await useAuthStore.getState().verifyTOTP('123456');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
  });

  it('a failed sign-in keeps the pending sign-up', async () => {
    useAuthStore.setState({ pendingRegistration: pendingState() });
    api.post.mockRejectedValue(axiosError(401, 'Invalid email or password'));
    await expect(useAuthStore.getState().login('b@example.com', 'wrong-password')).rejects.toBeTruthy();
    expect(useAuthStore.getState().pendingRegistration?.pendingId).toBe('p1');
  });

  it('logout clears a pending sign-up', () => {
    useAuthStore.setState({ pendingRegistration: pendingState(), user: { id: 'u1' } as never, isAuthenticated: true });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
  });
});

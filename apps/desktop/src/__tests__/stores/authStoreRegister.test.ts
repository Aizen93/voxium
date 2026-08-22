import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PowAbortedError } from '@voxium/shared';

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
vi.mock('../../services/socket', () => ({
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
  getSocket: vi.fn(() => null),
  getSocketGeneration: vi.fn(() => 0),
  onSocketReady: vi.fn(() => () => {}),
  onSocketReconnect: vi.fn(() => () => {}),
  onConnectionStatusChange: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => 'connected'),
}));
vi.mock('../../services/tokenStorage', () => ({
  getAccessToken: vi.fn(() => null),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  isRemembered: vi.fn(() => true),
}));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import { useAuthStore } from '../../stores/authStore';

const CHALLENGE = { challenge: 'a'.repeat(32), difficulty: 1, expires: Date.now() + 60_000, sig: 'f'.repeat(64) };

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: { data: CHALLENGE } });
  useAuthStore.setState({
    user: null, isAuthenticated: false, isSubmitting: false, isRegistering: false,
    error: null, powProgress: null,
  });
});

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
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123');
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
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123');
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
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123');
    await vi.waitFor(() => expect(useAuthStore.getState().isRegistering).toBe(true));

    useAuthStore.getState().cancelRegistration();
    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);

    expect(useAuthStore.getState().error).toBeNull();
  });

  it('passes an abort signal through to the solver', async () => {
    hangingSolve();
    const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123');
    await vi.waitFor(() => expect(solver.solveRegistrationPowOffThread).toHaveBeenCalled());

    const signal = solver.solveRegistrationPowOffThread.mock.calls[0][2] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    useAuthStore.getState().cancelRegistration();
    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
  });

  it('completes normally when nobody cancels', async () => {
    solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
    api.post.mockResolvedValue({
      data: { data: { user: { id: 'u1', emailVerified: false }, accessToken: 'at', refreshToken: 'rt' } },
    });

    await useAuthStore.getState().register('alice', 'a@example.com', 'password123');

    expect(api.post).toHaveBeenCalledWith('/auth/register', expect.objectContaining({ username: 'alice' }));
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().isRegistering).toBe(false);
    expect(useAuthStore.getState().powProgress).toBeNull();
    expect(useAuthStore.getState().isSubmitting).toBe(false);
  });

  // The solve is abortable; the POST that follows it is not. Walking away
  // while it is in flight used to leak its outcome onto whatever page the
  // user went to: `error` is shared with LoginPage.
  describe('cancel while the POST is in flight', () => {
    function hangingPost() {
      let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
      api.post.mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));
      return () => settle;
    }

    it('does not surface a 409 from the abandoned registration as an error on the next page', async () => {
      solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
      const post = hangingPost();

      const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123');
      await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
      useAuthStore.getState().cancelRegistration(); // RegisterPage unmounted → LoginPage mounted, clearError ran
      post().reject(Object.assign(new Error('conflict'), { response: { status: 409, data: { error: 'Username or email already in use' } } }));

      await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
      expect(useAuthStore.getState().error).toBeNull();
      expect(useAuthStore.getState().isRegistering).toBe(false);
    });

    it('still finishes the sign-in on success when nobody else signed in meanwhile — the account exists now', async () => {
      solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
      const post = hangingPost();

      const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123');
      await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
      useAuthStore.getState().cancelRegistration();
      post().resolve({ data: { data: { user: { id: 'u-new', emailVerified: false }, accessToken: 'at', refreshToken: 'rt' } } });

      await pending;
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().user?.id).toBe('u-new');
    });

    it('does NOT replace a session the user established as someone else while the POST was in flight', async () => {
      solver.solveRegistrationPowOffThread.mockResolvedValue({ ...CHALLENGE, nonce: '3' });
      const post = hangingPost();

      const pending = useAuthStore.getState().register('alice', 'a@example.com', 'password123');
      await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
      useAuthStore.getState().cancelRegistration();
      // Meanwhile: logged in as an existing account on LoginPage
      useAuthStore.setState({ user: { id: 'u-existing' } as never, isAuthenticated: true });
      post().resolve({ data: { data: { user: { id: 'u-new', emailVerified: true }, accessToken: 'at', refreshToken: 'rt' } } });

      await pending;
      expect(useAuthStore.getState().user?.id).toBe('u-existing');
      const { setTokens } = await import('../../services/tokenStorage');
      expect(setTokens).not.toHaveBeenCalledWith('at', 'rt', true);
    });
  });
});

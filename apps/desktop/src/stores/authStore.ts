import { create } from 'zustand';
import { api } from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';
import { getAccessToken, setTokens, clearTokens, isRemembered } from '../services/tokenStorage';
import { useServerStore } from './serverStore';
import { useChatStore } from './chatStore';
import { useVoiceStore } from './voiceStore';
import { resetAccountStores } from './resetStores';
import { processImage } from '../utils/imageProcessing';
import i18n from '../i18n';
import { getTranslatedError } from '../utils/serverErrors';
import type { User, RegistrationConsent } from '@voxium/shared';
import { PowExpiredError, PowAbortedError } from '@voxium/shared';
import { solveRegistrationPowOffThread } from '../services/powSolver';

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
  register: (username: string, email: string, password: string, consent: RegistrationConsent) => Promise<void>;
  /** Abandon an in-flight registration: stop the solve and clear its state.
   *  Without it the abandoned solve finishes, POSTs, and signs the user into
   *  the account they walked away from. */
  cancelRegistration: () => void;
  logout: () => void;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  uploadAvatar: (file: File) => Promise<void>;
  updateProfile: (fields: { displayName?: string; bio?: string }) => Promise<void>;
  forgotPassword: (email: string) => Promise<string>;
  resetPassword: (token: string, password: string) => Promise<string>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<string>;
  resendVerification: () => Promise<void>;
  setupTOTP: () => Promise<{ secret: string; qrCodeDataUrl: string }>;
  enableTOTP: (code: string) => Promise<string[]>;
  disableTOTP: (code: string) => Promise<void>;
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

/** The in-flight registration's abort handle. Module scope, not store state:
 *  it is a live object, never rendered, and must not be part of the reset
 *  snapshot `resetAccountStores` captures. */
let registrationAbort: AbortController | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  isSubmitting: false,
  isRegistering: false,
  error: null,
  powProgress: null,
  totpRequired: false,
  totpToken: null,
  totpRememberMe: true,

  login: async (email, password, rememberMe = true) => {
    set({ isSubmitting: true, error: null });
    try {
      const trustedDeviceToken = localStorage.getItem('voxium_trusted_device') || undefined;
      const { data } = await api.post('/auth/login', { email, password, rememberMe, trustedDeviceToken });

      // If TOTP is required, pause login flow
      if (data.data.totpRequired) {
        set({ totpRequired: true, totpToken: data.data.totpToken, totpRememberMe: rememberMe, isSubmitting: false });
        return;
      }

      const { user, accessToken, refreshToken } = data.data;
      setTokens(accessToken, refreshToken, rememberMe);
      if (user.emailVerified) {
        connectSocket(accessToken);
      }
      set({ user, isAuthenticated: true, isSubmitting: false });
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
        localStorage.setItem('voxium_trusted_device', trustedDeviceToken);
      }
      if (user.emailVerified) {
        connectSocket(accessToken);
      }
      set({ user, isAuthenticated: true, isSubmitting: false, totpRequired: false, totpToken: null, totpRememberMe: true });
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
    set({ isRegistering: true, error: null, powProgress: 0 });
    try {
      // Anti-bot proof-of-work: fetch a challenge and burn CPU solving it. No
      // captcha, no third-party service, nothing leaves our infrastructure.
      // Solved in a worker so the page stays interactive, with progress shown
      // — under subnet pressure this is tens of seconds, not a blink.
      const pow = await solveWithRetry((fraction) => set({ powProgress: fraction }), controller.signal);
      if (controller.signal.aborted) throw new PowAbortedError();

      const { data } = await api.post('/auth/register', { username, email, password, pow, ...consent });
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

      // Don't connect socket until email is verified
      if (user.emailVerified) {
        connectSocket(accessToken);
      }

      set({ user, isAuthenticated: true, isRegistering: false, powProgress: null });
    } catch (err) {
      // An abandoned solve is not a failure to report — the view is gone and
      // `cancelRegistration` already cleared the flags. The same goes for a
      // POST that was already in flight when the view was left: the store's
      // `error` is shared with LoginPage, which would render a 409 from this
      // abandoned registration as a failed login the user never attempted.
      if (err instanceof PowAbortedError) throw err;
      if (controller.signal.aborted) throw new PowAbortedError();
      set({
        error: getTranslatedError(err, i18n.t, 'auth.register.registrationFailed'),
        isRegistering: false,
        powProgress: null,
      });
      throw err;
    } finally {
      if (registrationAbort === controller) registrationAbort = null;
    }
  },

  cancelRegistration: () => {
    registrationAbort?.abort();
    registrationAbort = null;
    set({ isRegistering: false, powProgress: null });
  },

  logout: () => {
    // Clean up voice state before disconnecting socket (stops mic, audio pipeline)
    const vs = useVoiceStore.getState();
    if (vs.activeChannelId) vs.leaveChannel();
    if (vs.dmCallConversationId) vs.leaveDMCall();

    clearTokens();
    disconnectSocket();
    // Wipe every account-scoped store — on a shared machine the next login must
    // never see the previous account's servers, DMs, or support transcript
    resetAccountStores();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    const token = getAccessToken();
    if (!token) {
      set({ isLoading: false });
      return;
    }

    try {
      const { data } = await api.get('/auth/me');
      if (data.data.emailVerified) {
        connectSocket(token);
      }
      set({ user: data.data, isAuthenticated: true, isLoading: false });
    } catch {
      clearTokens();
      set({ isLoading: false });
    }
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
    localStorage.removeItem('voxium_trusted_device');
    set((state) => ({ user: state.user ? { ...state.user, totpEnabled: false } : null }));
  },
}));

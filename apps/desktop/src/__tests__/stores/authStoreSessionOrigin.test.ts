import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The launch's session restore with the REAL session storage behind it: a
// desktop build made for another server shares the OS credential entries
// with the official app, and must never send the official session to its
// own server (nor the reverse). The only senders, /auth/me here and the
// refresh in services/session.ts, read the tokens from the storage's memory.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));

const socket = vi.hoisted(() => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), reconnectSocketAfterCredentialChange: vi.fn(), endCredentialChange: vi.fn(), beginCredentialChange: vi.fn() }));
vi.mock('../../services/socket', () => ({
  connectSocket: socket.connectSocket,
  disconnectSocket: socket.disconnectSocket,
  reconnectSocketAfterCredentialChange: socket.reconnectSocketAfterCredentialChange,
  beginCredentialChange: socket.beginCredentialChange,
  getSocket: vi.fn(() => null),
  getSocketGeneration: vi.fn(() => 0),
  onSocketReady: vi.fn(() => () => {}),
  onSocketReconnect: vi.fn(() => () => {}),
  onConnectionStatusChange: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => 'connected'),
}));

const session = vi.hoisted(() => ({ SessionLostError: class SessionLostError extends Error {}, endSessionRenewals: vi.fn() }));
vi.mock('../../services/session', () => session);
vi.mock('../../stores/resetStores', () => ({ resetAccountStores: vi.fn() }));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => ({ activeChannelId: null, dmCallConversationId: null, leaveChannel: vi.fn(), leaveDMCall: vi.fn() }) },
}));
vi.mock('../../services/powSolver', () => ({ solveRegistrationPowOffThread: vi.fn() }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('../../utils/imageProcessing', () => ({ processImage: vi.fn() }));

import { useAuthStore, _resetSessionRestoreForTests } from '../../stores/authStore';
import { createKeychainSessionStore, getRefreshToken, getTrustedDeviceToken, _resetTokenStorageForTests } from '../../services/tokenStorage';

const OFFICIAL = 'https://voxium.app';
const COMMUNITY = 'https://chat.example.org';
const me = { id: 'u-1', username: 'alice', emailVerified: true, consentRequired: false };

/** The Rust commands over a Map; the official app's session as an older build stored it (no origin). */
function keychainWith(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const name = args?.name as string;
    if (cmd === 'session_secret_get') return (map.get(name) ?? null) as T;
    if (cmd === 'session_secret_set') { map.set(name, args?.value as string); return undefined as T; }
    if (cmd === 'session_secret_delete') { map.delete(name); return undefined as T; }
    throw new Error(`unknown command ${cmd}`);
  };
}
const legacyEntries = { tokens: JSON.stringify({ accessToken: 'official-access', refreshToken: 'official-refresh' }), 'trusted-device': 'official-trusted' };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  _resetSessionRestoreForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
});

afterEach(() => {
  _resetSessionRestoreForTests();
  vi.restoreAllMocks();
});

describe('the session restore never sends a session issued by another server', () => {
  it('a community build with the official app\'s session in the keychain sends nothing and signs nobody in', async () => {
    _resetTokenStorageForTests(createKeychainSessionStore(keychainWith(legacyEntries), { apiOrigin: COMMUNITY }));

    await useAuthStore.getState().checkAuth();

    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(socket.connectSocket).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBeNull();
    expect(getTrustedDeviceToken()).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, isLoading: false });
  });

  it('the official app with the same entries restores its session as before the update', async () => {
    let bearerAtRequest: string | null = null;
    api.get.mockImplementationOnce(async () => {
      const { getAccessToken } = await import('../../services/tokenStorage');
      bearerAtRequest = getAccessToken();
      return { data: { data: me } };
    });
    _resetTokenStorageForTests(createKeychainSessionStore(keychainWith(legacyEntries), { apiOrigin: OFFICIAL }));

    await useAuthStore.getState().checkAuth();

    expect(api.get).toHaveBeenCalledWith('/auth/me', expect.anything());
    expect(bearerAtRequest).toBe('official-access');
    expect(getRefreshToken()).toBe('official-refresh');
    expect(useAuthStore.getState()).toMatchObject({ user: me, isAuthenticated: true });
  });
});

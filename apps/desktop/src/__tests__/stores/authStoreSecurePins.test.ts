import { describe, it, expect, vi, beforeEach } from 'vitest';

// The secure-channel pins follow the signed-in account: activated by every
// path that sets the user, deactivated (never wiped) by logout, wiped only by
// self-service account deletion.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../services/powSolver', () => ({ solveRegistrationPowOffThread: vi.fn() }));
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
  getAccessToken: vi.fn(() => 'tok'),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  isRemembered: vi.fn(() => true),
  hydrateTokens: vi.fn(async () => true),
  getTrustedDeviceToken: vi.fn(() => null),
  setTrustedDeviceToken: vi.fn(),
  clearTrustedDeviceToken: vi.fn(),
}));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
const e2e = vi.hoisted(() => ({ forgetLocalE2EState: vi.fn() }));
vi.mock('../../services/e2e/e2eService', () => e2e);
// The store wipe is covered by resetStores.test.ts; here it would pull the
// whole E2E service in for nothing.
vi.mock('../../stores/resetStores', () => ({ resetAccountStores: vi.fn() }));

import { useAuthStore } from '../../stores/authStore';
import { isPinnedSecure, pinSecure, securePinStorageKey } from '../../utils/securePins';
import type { User } from '@voxium/shared';

const alice = { id: 'alice', username: 'alice', emailVerified: true } as unknown as User;

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null, isAuthenticated: false });
  localStorage.clear();
});

describe('authStore — secure-channel pin lifecycle', () => {
  it('session restore activates the account; logout deactivates without wiping', async () => {
    api.get.mockResolvedValueOnce({ data: { data: alice } });
    await useAuthStore.getState().checkAuth();
    expect(pinSecure('ch-1')).toBe(true);
    expect(isPinnedSecure('ch-1')).toBe(true);

    useAuthStore.getState().logout();
    expect(isPinnedSecure('ch-1')).toBe(false); // nobody signed in
    expect(localStorage.getItem(securePinStorageKey('alice'))).not.toBeNull();

    useAuthStore.setState({ user: alice });
    expect(isPinnedSecure('ch-1')).toBe(true);
  });

  it('self-service deletion forgets the pins with the E2E state', async () => {
    useAuthStore.setState({ user: alice, isAuthenticated: true });
    pinSecure('ch-1');
    api.delete.mockResolvedValueOnce({ data: {} });

    await useAuthStore.getState().deleteAccount('password123');

    expect(e2e.forgetLocalE2EState).toHaveBeenCalledWith('alice');
    expect(localStorage.getItem(securePinStorageKey('alice'))).toBeNull();
    useAuthStore.setState({ user: alice });
    expect(isPinnedSecure('ch-1')).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The server's `force:logout` over the REAL socket module, auth store,
// session storage and renewal: only socket.io-client, the voice store, the
// store reset, the proof-of-work solver, i18n and the network are stand-ins.
// The tab of these tests held a not-remembered session (A) when its socket
// was admitted, then followed another tab's remembered sign-in to the same
// account (Q): the socket still names A.

interface FakeSocket {
  handlers: Map<string, (...args: unknown[]) => void>;
  auth: Record<string, unknown>;
  connected: boolean;
  active: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  fire: (event: string, ...args: unknown[]) => void;
}

const created = vi.hoisted(() => [] as FakeSocket[]);
vi.mock('socket.io-client', () => ({
  io: vi.fn((_url: string, opts?: { auth?: Record<string, unknown> }) => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const s = {
      handlers,
      auth: opts?.auth ?? {},
      connected: false,
      active: true,
      id: 'fake',
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers.set(event, cb);
        return s;
      }),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      onAny: vi.fn(),
      onAnyOutgoing: vi.fn(),
      disconnect: vi.fn(() => { s.active = false; }),
      connect: vi.fn(() => { s.active = true; }),
      io: { on: vi.fn(), removeAllListeners: vi.fn() },
      fire: (event: string, ...args: unknown[]) => {
        const handler = handlers.get(event);
        if (!handler) throw new Error(`No handler registered for '${event}'`);
        handler(...args);
      },
    };
    created.push(s as unknown as FakeSocket);
    return s;
  }),
}));
vi.mock('../../stores/resetStores', () => ({ resetAccountStores: vi.fn() }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => ({ activeChannelId: null, dmCallConversationId: null }) } }));
vi.mock('../../services/powSolver', () => ({ solveRegistrationPowOffThread: vi.fn() }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import { useAuthStore, _resetSessionRestoreForTests } from '../../stores/authStore';
import { connectSocket, disconnectSocket, _setSocketRandomForTests, _resetSocketModuleForTests } from '../../services/socket';
import {
  getRefreshToken, setTokens, flushTokenStorage, _resetTokenStorageForTests, _setPageReloadForTests, _setSessionChannelForTests,
} from '../../services/tokenStorage';
import { _resetSessionForTests, setSessionLostNavigation, _setRefreshLocksForTests } from '../../services/session';
import { _resetSessionRevocationForTests } from '../../services/sessionRevocation';

const ACCESS = 'voxium_access_token';
const REFRESH = 'voxium_refresh_token';

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}
const exp = () => Math.floor(Date.now() / 1000) + 900;
const pairOf = (userId: string, sid: string, gen = 1) => ({ accessToken: jwt({ userId, sid, exp: exp(), n: gen }), refreshToken: jwt({ userId, sid, gen }) });

const reload = vi.fn();
const navigate = vi.fn();
const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTokenStorageForTests();
  _resetSessionForTests();
  _resetSessionRestoreForTests();
  _resetSessionRevocationForTests();
  _resetSocketModuleForTests();
  _setPageReloadForTests(reload);
  setSessionLostNavigation(navigate);
  _setRefreshLocksForTests(null);
  _setSessionChannelForTests(null);
  _setSocketRandomForTests(() => 0);
  reload.mockClear();
  navigate.mockClear();
  fetchMock.mockClear();
  created.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  disconnectSocket();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Another tab of this browser stores a remembered pair; `heard`: this tab gets its `storage` event now. */
function otherTabSignsIn(p: { accessToken: string; refreshToken: string }, heard = true): void {
  localStorage.setItem(ACCESS, p.accessToken);
  localStorage.setItem(REFRESH, p.refreshToken);
  if (heard) window.dispatchEvent(new StorageEvent('storage', { key: REFRESH, storageArea: localStorage }));
}

/** This tab holds session A (not remembered), its socket admitted with it; `followQ`: it has followed another tab's sign-in to Q since. */
async function socketOfSessionA(followQ = true) {
  const a = pairOf('user-x', 's-A');
  setTokens(a.accessToken, a.refreshToken, false);
  await flushTokenStorage();
  useAuthStore.setState({ user: { id: 'user-x', username: 'x', emailVerified: true } as never, isAuthenticated: true, isLoading: false });
  connectSocket(a.accessToken);
  const s = created[0];
  s.connected = true;
  s.fire('connect');
  const q = pairOf('user-x', 's-Q');
  if (followQ) {
    otherTabSignsIn(q);
    expect(getRefreshToken()).toBe(q.refreshToken);
  }
  return { a, q, s };
}

describe('a ban or a deletion signs out whatever session of the account this tab holds', () => {
  it.each([
    ['Your account has been banned', 'banned'],
    ['Your account has been deleted', 'deleted'],
  ])('"%s", told to a socket admitted with the session the tab let go of: the sign-in page says so', async (serverReason, code) => {
    const { s } = await socketOfSessionA();

    s.fire('force:logout', { reason: serverReason });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/login?reason=${code}`);
    expect(reload).not.toHaveBeenCalled();
    // the session held now ended with the account: gone from this browser
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem(REFRESH)).toBeNull();
    expect(sessionStorage.getItem(REFRESH)).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('another account signed in in the meantime is not this end\'s to sign out: the page reloads onto it', async () => {
    const { s } = await socketOfSessionA(false);
    const y = pairOf('user-y', 's-Y');
    // heard later: the memory still holds A when the ban arrives
    otherTabSignsIn(y, false);

    s.fire('force:logout', { reason: 'Your account has been banned' });
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    expect(navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem(REFRESH)).toBe(y.refreshToken);
  });
});

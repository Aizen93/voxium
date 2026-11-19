import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// While the server deletes an account it ends the account's sessions: a
// `force:logout` to every socket of the account (the deleting client's
// included) before its transaction and again after the commit, and a refusal
// of every other request. Each of those changes the page to the login page.
// The deletion's own local clean-up (the vault, its key, the secure-channel
// pins, the trusted-device token) must have finished first; a deletion that
// failed must have erased nothing (the account may still exist). Real auth
// store, socket handler, session module and E2E service; the socket.io
// client, the API, the token store and the key backend are stand-ins.

// ─── The socket the server sends force:logout on ────────────────────────────
type Handler = (...args: unknown[]) => void;
const sockets = vi.hoisted(() => [] as Array<{ handlers: Map<string, Handler> }>);
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const handlers = new Map<string, Handler>();
    const s = {
      handlers,
      on: vi.fn((event: string, cb: Handler) => {
        handlers.set(event, cb);
        return s;
      }),
      off: vi.fn(),
      onAny: vi.fn(),
      onAnyOutgoing: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      connected: false,
      active: true,
      auth: {},
      id: 'fake',
      io: { on: vi.fn(), removeAllListeners: vi.fn() },
    };
    sockets.push(s);
    return s;
  }),
}));

// ─── What the test watches, in order ────────────────────────────────────────
const events = vi.hoisted(() => [] as string[]);

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn(), put: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));

const storage = vi.hoisted(() => ({
  getAccessToken: vi.fn(() => 'tok' as string | null),
  getRefreshToken: vi.fn(() => null as string | null),
  setTokens: vi.fn((access: string) => void events.push(`tokens set (${access})`)),
  clearTokens: vi.fn(() => void events.push('tokens cleared')),
  isRemembered: vi.fn(() => true),
  hydrateTokens: vi.fn(async () => true),
  getTrustedDeviceToken: vi.fn(() => null as string | null),
  setTrustedDeviceToken: vi.fn((token: string) => void events.push(`trusted-device token set (${token})`)),
  clearTrustedDeviceToken: vi.fn(() => void events.push('trusted-device token cleared')),
  flushTokenStorage: vi.fn(async () => void events.push('token store flushed')),
}));
vi.mock('../../services/tokenStorage', () => storage);

/** The key backend of the build: its removal is what the deletion must wait for. */
const keys = vi.hoisted(() => ({
  load: vi.fn(async () => btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))),
  save: vi.fn(async () => {}),
  remove: vi.fn(async (_userId: string) => {}),
}));
vi.mock('../../services/e2e/pickleKeyProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/e2e/pickleKeyProvider')>()),
  defaultPickleKeyProvider: () => keys,
}));

vi.mock('../../services/powSolver', () => ({ solveRegistrationPowOffThread: vi.fn() }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import type { User } from '@voxium/shared';
import { useAuthStore } from '../../stores/authStore';
import { connectSocket, disconnectSocket } from '../../services/socket';
import { handleSessionLost, setSessionLostNavigation } from '../../services/session';
import { ACCOUNT_DELETION_WAIT_MS, accountDeletionInFlight } from '../../services/accountDeletion';
import { E2EVault, vaultDbName } from '../../services/e2e/vault';
import { pinSecure, securePinStorageKey } from '../../utils/securePins';

const alice = { id: 'alice', username: 'alice', emailVerified: true } as unknown as User;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending promise chain run (the handler's dynamic import included). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The events of a test but the token clears (every logout makes one; the sign-in tests watch them). */
function steps(): string[] {
  return events.filter((event) => event !== 'tokens cleared');
}

async function vaultNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((db) => db.name ?? '');
}

const originalLocation = window.location;
let forceLogout: Handler;
// A channel of its own per test: the pins of an account are also remembered in memory
let pinned = 0;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.clearAllMocks();
  events.length = 0;
  sockets.length = 0;
  localStorage.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  Object.defineProperty(window, 'location', {
    value: {
      _href: '',
      get href() {
        return this._href;
      },
      set href(value: string) {
        this._href = value;
        events.push(`navigated to ${value}`);
      },
    },
    writable: true,
    configurable: true,
  });
  keys.remove.mockImplementation(async () => void events.push('vault key removed'));

  // Signed in, with a vault on the device, a pinned secure channel and a socket
  useAuthStore.setState({ user: alice, isAuthenticated: true });
  const vault = new E2EVault('alice', keys);
  await vault.open();
  vault.close();
  pinned += 1;
  expect(pinSecure(`ch-${pinned}`)).toBe(true);
  connectSocket('tok');
  forceLogout = sockets[0].handlers.get('force:logout')!;
});

afterEach(() => {
  disconnectSocket();
  warn.mockRestore();
  // what a test set up for a sign-in stays with it
  api.post.mockReset();
  api.get.mockReset();
  storage.getAccessToken.mockReturnValue('tok');
  useAuthStore.setState({ totpRequired: false, totpToken: null, pendingRegistration: null });
  Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
});

/** Records whether the vault was still on the device when its key was removed. */
function watchVaultAtKeyRemoval(gate?: Promise<void>) {
  const atRemoval: string[][] = [];
  keys.remove.mockImplementation(async () => {
    atRemoval.push(await vaultNames());
    await gate;
    events.push('vault key removed');
  });
  return atRemoval;
}

function expectLocalStateErased(atRemoval: string[][]) {
  expect(keys.remove).toHaveBeenCalledWith('alice');
  expect(atRemoval[0]).not.toContain(vaultDbName('alice'));
  expect(localStorage.getItem(securePinStorageKey('alice'))).toBeNull();
  expect(storage.clearTrustedDeviceToken).toHaveBeenCalledTimes(1);
}

describe('a force:logout during an account deletion of this client', () => {
  it('changes the page only once the vault, its key, the pins and the trusted-device token are gone', async () => {
    const answer = deferred<{ data: object }>();
    api.delete.mockReturnValueOnce(answer.promise);
    const keyGate = deferred<void>();
    const atRemoval = watchVaultAtKeyRemoval(keyGate.promise);

    const deletion = useAuthStore.getState().deleteAccount('password123');
    expect(accountDeletionInFlight()).toBe(true);
    // the server's first one, before its transaction
    forceLogout({ reason: 'account_deleted' });
    await settle();
    expect(useAuthStore.getState().user).toBeNull(); // the handler's own logout ran
    expect(window.location.href).toBe(''); // and it waits

    answer.resolve({ data: {} });
    await vi.waitFor(() => expect(keys.remove).toHaveBeenCalledWith('alice'));
    await settle();
    expect(window.location.href).toBe(''); // the key removal is still out

    keyGate.resolve();
    await deletion;
    await settle();
    expectLocalStateErased(atRemoval);
    expect(accountDeletionInFlight()).toBe(false);
    expect(steps()).toEqual([
      'token store flushed', // the handler's flush of its logout
      'trusted-device token cleared',
      'vault key removed',
      'token store flushed', // the deletion's flush of the trusted-device clear
      'navigated to /login?reason=account_deleted',
    ]);
  });

  it('the same when the answer arrives while the handler is still flushing the token store', async () => {
    const answer = deferred<{ data: object }>();
    api.delete.mockReturnValueOnce(answer.promise);
    const flush = deferred<void>();
    storage.flushTokenStorage.mockImplementationOnce(async () => {
      await flush.promise;
      events.push('token store flushed (handler)');
    });
    const keyGate = deferred<void>();
    const atRemoval = watchVaultAtKeyRemoval(keyGate.promise);

    const deletion = useAuthStore.getState().deleteAccount('password123');
    forceLogout({ reason: 'account_deleted' });
    await settle();
    answer.resolve({ data: {} });
    await settle();
    // the handler's flush ends while the key removal is still out: it waits
    flush.resolve();
    await settle();
    expect(window.location.href).toBe('');
    keyGate.resolve();
    await deletion;
    await settle();

    expectLocalStateErased(atRemoval);
    expect(events.at(-1)).toBe('navigated to /login?reason=account_deleted');
    expect(events.indexOf('vault key removed')).toBeLessThan(events.indexOf('navigated to /login?reason=account_deleted'));
    expect(events.filter((e) => e.startsWith('navigated'))).toHaveLength(1);
  });

  it('a second force:logout (after the commit) changes nothing more', async () => {
    api.delete.mockResolvedValueOnce({ data: {} });
    const deletion = useAuthStore.getState().deleteAccount('password123');
    forceLogout({ reason: 'account_deleted' });
    forceLogout({ reason: 'account_deleted' });
    await deletion;
    await settle();
    expect(keys.remove).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('/login?reason=account_deleted');
  });

  it.each([
    ['a 409 (the account still owns spaces)', Object.assign(new Error('Request failed with status code 409'), { response: { status: 409 } })],
    ['a 500', Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } })],
    ['a network error', new Error('Network Error')],
  ])('a deletion that fails with %s erases nothing, and the page still changes', async (_name, failure) => {
    const answer = deferred<{ data: object }>();
    api.delete.mockReturnValueOnce(answer.promise);

    const deletion = useAuthStore.getState().deleteAccount('password123');
    forceLogout({ reason: 'account_deleted' });
    await settle();
    expect(window.location.href).toBe('');
    answer.reject(failure);
    await expect(deletion).rejects.toBe(failure);
    await settle();

    expect(window.location.href).toBe('/login?reason=account_deleted');
    expect(accountDeletionInFlight()).toBe(false);
    expect(keys.remove).not.toHaveBeenCalled();
    expect(await vaultNames()).toContain(vaultDbName('alice'));
    expect(localStorage.getItem(securePinStorageKey('alice'))).not.toBeNull();
    expect(storage.clearTrustedDeviceToken).not.toHaveBeenCalled();
  });

  it(`gives up waiting after ${ACCOUNT_DELETION_WAIT_MS / 1000} s, with one warning`, async () => {
    const answer = deferred<{ data: object }>();
    api.delete.mockReturnValueOnce(answer.promise);
    vi.useFakeTimers();
    const deletion = useAuthStore.getState().deleteAccount('password123');
    try {
      forceLogout({ reason: 'account_deleted' });
      // the handler's logout, its flush, then the wait (vi.waitFor would move the fake clock)
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(steps()).toEqual(['token store flushed']);
      await vi.advanceTimersByTimeAsync(ACCOUNT_DELETION_WAIT_MS - 1);
      expect(window.location.href).toBe('');
      await vi.advanceTimersByTimeAsync(1);
      expect(window.location.href).toBe('/login?reason=account_deleted');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[Account] The account deletion did not finish its local clean-up in time — leaving the page');
    } finally {
      vi.useRealTimers();
      // the request, answered at last, ends the deletion it belongs to
      answer.reject(new Error('Network Error'));
      await expect(deletion).rejects.toThrow('Network Error');
    }
    expect(accountDeletionInFlight()).toBe(false);
    expect(keys.remove).not.toHaveBeenCalled();
  });
});

describe('a session started while an account deletion of this client is in flight', () => {
  const bob = { id: 'bob', username: 'bob', emailVerified: true } as unknown as User;
  const bobSignedIn = { data: { data: { user: bob, accessToken: 'access-bob', refreshToken: 'refresh-bob' } } };

  it('a sign-in posts nothing until the deletion has ended, and the cleanup clears nothing of it', async () => {
    const answer = deferred<{ data: object }>();
    api.delete.mockReturnValueOnce(answer.promise);
    api.post.mockResolvedValueOnce(bobSignedIn);

    const deletion = useAuthStore.getState().deleteAccount('password123');
    forceLogout({ reason: 'account_deleted' });
    await settle();
    // the login page is on screen: someone signs in to another account
    const signIn = useAuthStore.getState().login('bob@example.org', 'password456');
    await settle();
    expect(api.post).not.toHaveBeenCalled();

    answer.resolve({ data: {} });
    await deletion;
    await signIn;
    await settle();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/auth/login', expect.objectContaining({ email: 'bob@example.org' }));
    // the deleting account's cleanup ran, all of it before the new session
    expect(keys.remove).toHaveBeenCalledWith('alice');
    const stored = events.indexOf('tokens set (access-bob)');
    expect(stored).toBeGreaterThan(events.indexOf('vault key removed'));
    expect(stored).toBeGreaterThan(events.indexOf('trusted-device token cleared'));
    // and nothing after it took the new session away
    expect(events.slice(stored)).not.toContain('tokens cleared');
    expect(events.slice(stored)).not.toContain('trusted-device token cleared');
    expect(useAuthStore.getState().user).toEqual(bob);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('the two-factor step, both sign-up steps, a password change and a session restore wait too', async () => {
    const answer = deferred<{ data: object }>();
    api.delete.mockReturnValueOnce(answer.promise);
    api.post.mockResolvedValue(bobSignedIn);
    api.get.mockResolvedValue({ data: { data: bob } });

    const deletion = useAuthStore.getState().deleteAccount('password123');
    forceLogout({ reason: 'account_deleted' });
    await settle();
    // another tab signed in meanwhile: the shared storage holds its session
    storage.getAccessToken.mockReturnValue('access-other-tab');

    useAuthStore.setState({ totpRequired: true, totpToken: 'totp-challenge' });
    const started = [
      useAuthStore.getState().verifyTOTP('123456'),
      useAuthStore.getState().register('bob', 'bob@example.org', 'password456', { acceptTerms: true, acceptPrivacy: true }),
      useAuthStore.getState().changePassword('password123', 'password789'),
      useAuthStore.getState().checkAuth(),
    ].map((p) => p.catch(() => undefined));
    useAuthStore.setState({
      pendingRegistration: { pendingId: 'pending-1', email: 'bob@example.org', resendAfterSeconds: 600, issuedAt: Date.now(), resendUsed: false, usernameTaken: false },
    });
    started.push(useAuthStore.getState().completeRegistration('123456').catch(() => undefined));
    await settle();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled(); // neither the challenge of the sign-up nor /auth/me

    answer.resolve({ data: {} });
    await deletion;
    await Promise.all(started);
    await settle();
    const firstRequest = Math.min(...[...api.post.mock.invocationCallOrder, ...api.get.mock.invocationCallOrder]);
    expect(firstRequest).toBeGreaterThan(Math.max(...storage.clearTrustedDeviceToken.mock.invocationCallOrder));
    expect(firstRequest).toBeGreaterThan(Math.max(...keys.remove.mock.invocationCallOrder));
  });
});

describe('with no account deletion in flight', () => {
  it('a sign-in posts at once, as before', () => {
    api.post.mockReturnValueOnce(new Promise(() => {}));
    void useAuthStore.getState().login('bob@example.org', 'password456');
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('a force:logout changes the page right after its token flush, as before', async () => {
    forceLogout({ reason: 'banned' });
    await settle();
    expect(steps()).toEqual(['token store flushed', 'navigated to /login?reason=banned']);
    expect(useAuthStore.getState().user).toBeNull();
    expect(keys.remove).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a lost session (a refused renewal) changes the page right after the flush, as before', async () => {
    const navigate = vi.fn(() => void events.push('navigated to /login'));
    setSessionLostNavigation(navigate);
    handleSessionLost();
    await settle();
    expect(steps()).toEqual(['token store flushed', 'navigated to /login']);
  });
});

describe('a lost session during an account deletion of this client', () => {
  it('changes the page only once the local clean-up is done', async () => {
    const navigate = vi.fn(() => void events.push('navigated to /login'));
    setSessionLostNavigation(navigate);
    const answer = deferred<{ data: object }>();
    api.delete.mockReturnValueOnce(answer.promise);
    const atRemoval = watchVaultAtKeyRemoval();

    const deletion = useAuthStore.getState().deleteAccount('password123');
    // another request refused while the server deletes the account
    handleSessionLost();
    await settle();
    expect(navigate).not.toHaveBeenCalled();

    answer.resolve({ data: {} });
    await deletion;
    await settle();
    expectLocalStateErased(atRemoval);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe('navigated to /login');
    expect(events.indexOf('vault key removed')).toBeLessThan(events.indexOf('navigated to /login'));
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The screen in front of the app (components/layout/VaultOwnershipGate.tsx):
// the app mounts only in the tab that owns the account's encrypted vault.
// THIS test page is one tab; every other tab is played by the test, through
// the fake lock manager and a channel of its own on the fake bus
// (helpers/fakeVaultOwnership.ts), the way its own ownership module would.

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) };
});

const socket = vi.hoisted(() => {
  const state = { holds: 0, lifted: 0 };
  return {
    state,
    holdSocketConnections: vi.fn(() => {
      state.holds++;
      return () => {
        state.lifted++;
      };
    }),
    connectSocket: vi.fn(),
  };
});
vi.mock('../../services/socket', () => ({ holdSocketConnections: socket.holdSocketConnections, connectSocket: socket.connectSocket }));
vi.mock('../../services/tokenStorage', () => ({ getAccessToken: () => 'access-token' }));
const me = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../services/api', () => ({ api: { get: (...a: unknown[]) => me.get(...a) } }));
const voice = vi.hoisted(() => ({
  activeChannelId: null as string | null,
  dmCallConversationId: null as string | null,
  leaveChannel: vi.fn(),
  leaveDMCall: vi.fn(),
}));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => voice } }));
const auth = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => auth } }));

import { VaultOwnershipGate, installVaultOwnershipHooks, _resetVaultOwnershipGatesForTests } from '../../components/layout/VaultOwnershipGate';
import {
  getVaultOwnershipState,
  LOCK_REQUEST_SETTLE_MS,
  OWNER_REPLY_TIMEOUT_MS,
  TAKEOVER_INTENT_KEY,
  VAULT_LOCK_PREFIX,
  _resetVaultOwnershipForTests,
  _setVaultOwnershipEnvironmentForTests,
  _vaultKeyForTests,
} from '../../services/e2e/vaultOwnership';
import { vaultDbName } from '../../services/e2e/vault';
import { registerE2ESessionUser } from '../../services/e2e/session';
import { releaseVaultOwnershipNotInUse } from '../../services/e2e/vaultOwnership';
import { Bus, FakeChannel, FakeLocks } from '../helpers/fakeVaultOwnership';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
let userId: string;
let lockName: string;
let vaultKey: string;
let locks: FakeLocks;
let bus: Bus;
let other: FakeChannel;
let session: Map<string, string>;
let reload: ReturnType<typeof vi.fn<() => void>>;
let container: HTMLDivElement;
let root: Root;

function install(opts: { locks?: boolean; hidden?: boolean } = {}) {
  _setVaultOwnershipEnvironmentForTests({
    locks: opts.locks === false ? null : locks,
    openChannel: () => new FakeChannel(bus),
    stamp: async () => 'stamped',
    visibility: () => (opts.hidden ? 'hidden' : 'visible'),
    watchVisibility: () => () => {},
    watchPageLifecycle: () => {},
    session: () => ({
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    }),
    local: () => null,
    reload,
  });
}

/** The other tab, as owner: answers a question with `call`, and lets go when asked (unless `frozen`). */
function ownerTab(opts: { call?: 'none' | 'voice' | 'dm'; frozen?: boolean } = {}) {
  const tab = locks.otherTab(lockName);
  other.onmessage = ({ data }) => {
    if (opts.frozen) return;
    const m = data as Record<string, unknown>;
    if (m.vault !== vaultKey) return;
    if (m.type === 'query') other.postMessage({ v: 1, type: 'status', vault: vaultKey, to: m.from, nonce: m.nonce, call: opts.call ?? 'none' });
    if (m.type === 'release') {
      other.postMessage({ v: 1, type: 'releasing', vault: vaultKey, to: m.from, nonce: m.nonce });
      other.postMessage({ v: 1, type: 'released', vault: vaultKey, to: m.from, nonce: m.nonce });
    }
  };
  return tab;
}

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <VaultOwnershipGate key={userId} userId={userId}>
        <div data-testid="app">the app</div>
      </VaultOwnershipGate>
    );
  });
}

const text = () => container.textContent ?? '';
const appShown = () => container.querySelector('[data-testid="app"]') !== null;
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button "${label}" in: ${text()}`);
  return found as HTMLButtonElement;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}

beforeEach(() => {
  n++;
  userId = `gate-user-${n}`;
  const vaultName = vaultDbName(userId);
  lockName = `${VAULT_LOCK_PREFIX}${vaultName}`;
  vaultKey = _vaultKeyForTests(vaultName);
  _resetVaultOwnershipForTests();
  _resetVaultOwnershipGatesForTests();
  installVaultOwnershipHooks();
  locks = new FakeLocks();
  bus = new Bus();
  other = new FakeChannel(bus);
  session = new Map();
  reload = vi.fn<() => void>();
  install();
  socket.state.holds = 0;
  socket.state.lifted = 0;
  socket.holdSocketConnections.mockClear();
  socket.connectSocket.mockClear();
  me.get.mockReset();
  me.get.mockResolvedValue({ data: { data: { id: userId } } });
  voice.activeChannelId = null;
  voice.dmCallConversationId = null;
  voice.leaveChannel.mockClear();
  voice.leaveDMCall.mockClear();
  auth.logout.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  _resetVaultOwnershipForTests();
});

describe('VaultOwnershipGate', () => {
  it('mounts the app in the tab that owns the vault, and stays on the socket', async () => {
    mount();
    expect(appShown()).toBe(false); // nothing of the app before the vault is this tab's
    await settle();
    expect(appShown()).toBe(true);
    expect(socket.holdSocketConnections).not.toHaveBeenCalled();
    expect(me.get).not.toHaveBeenCalled();
  });

  it('shows the screen while another tab owns the vault, off the socket, with nothing of the app', async () => {
    ownerTab();
    mount();
    await settle();
    expect(appShown()).toBe(false);
    expect(text()).toContain('vaultOwnership.blockedTitle');
    expect(text()).toContain('vaultOwnership.waitingNote');
    expect(button('vaultOwnership.useHere')).toBeTruthy();
    expect(socket.state.holds).toBe(1);
    expect(socket.state.lifted).toBe(0);
    expect(getVaultOwnershipState(userId)).toBe('waiting');
  });

  it('takes over by itself when the owning tab closes: checks the session, then the app and the socket', async () => {
    const owner = ownerTab();
    mount();
    await settle();
    expect(text()).toContain('vaultOwnership.blockedTitle');

    owner.release(); // closed, crashed or signed out
    await settle();
    expect(me.get).toHaveBeenCalledWith('/auth/me');
    expect(appShown()).toBe(true);
    expect(socket.state.lifted).toBe(1);
    expect(socket.connectSocket).toHaveBeenCalledWith('access-token');
  });

  it('"Use it here" with no call there: asks, the owner lets go, and the app mounts here', async () => {
    const owner = ownerTab({ call: 'none' });
    mount();
    await settle();
    await click('vaultOwnership.useHere');
    await settle();
    expect(other.received.map((m) => m.type)).toEqual(['query', 'release', 'taken']);
    expect(owner.lost()).toBe(true);
    expect(appShown()).toBe(true);
    expect(socket.connectSocket).toHaveBeenCalledWith('access-token');
  });

  it('"Use it here" with a call there: the warning first; Cancel keeps the screen, confirming takes over', async () => {
    const owner = ownerTab({ call: 'voice' });
    mount();
    await settle();
    await click('vaultOwnership.useHere');
    await settle();
    expect(text()).toContain('vaultOwnership.callWarning');
    expect(other.received.map((m) => m.type)).toEqual(['query']); // nothing asked of the owner yet

    await click('vaultOwnership.cancel');
    expect(text()).toContain('vaultOwnership.blockedTitle');
    expect(text()).not.toContain('vaultOwnership.callWarning');
    expect(owner.lost()).toBe(false);

    await click('vaultOwnership.useHere');
    await settle();
    await click('vaultOwnership.useHere'); // the confirmation
    await settle();
    expect(owner.lost()).toBe(true);
    expect(appShown()).toBe(true);
  });

  it('a first lock request that never settles: the blank view until it is abandoned, then the waiting screen, and the app once the lock comes through the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callbacks: Array<(lock: unknown) => unknown> = [];
    const stamp = vi.fn(async () => 'stamped' as const);
    _setVaultOwnershipEnvironmentForTests({
      locks: {
        request: (_name, _options, callback) => {
          callbacks.push(callback);
          return new Promise<unknown>(() => {});
        },
      },
      openChannel: () => new FakeChannel(bus),
      stamp,
      visibility: () => 'visible',
      watchVisibility: () => () => {},
      watchPageLifecycle: () => {},
      session: () => null,
      local: () => null,
      reload,
    });
    try {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LOCK_REQUEST_SETTLE_MS - 1);
      });
      expect(appShown()).toBe(false);
      expect(text()).toBe(''); // the blank starting view, nothing of the app
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      // the screen of a tab that waits, with its ways forward; nothing written, nobody told
      expect(appShown()).toBe(false);
      expect(text()).toContain('vaultOwnership.blockedTitle');
      expect(text()).toContain('vaultOwnership.waitingNote');
      expect(button('vaultOwnership.useHere')).toBeTruthy();
      expect(stamp).not.toHaveBeenCalled();
      expect(other.received).toEqual([]);
      expect(socket.state.holds).toBe(1);

      // its place in the queue: the lock reaches it there
      expect(callbacks).toHaveLength(2);
      void callbacks[1]({ name: lockName, mode: 'exclusive' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(me.get).toHaveBeenCalledWith('/auth/me'); // the session checked first
      expect(appShown()).toBe(true);
      expect(socket.connectSocket).toHaveBeenCalledWith('access-token');
    } finally {
      warn.mockRestore();
    }
  });

  it('one tab and a lock manager slow to answer its first request: the app, through the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setVaultOwnershipEnvironmentForTests({
      locks: {
        request: (name, options, callback) =>
          options.ifAvailable ? new Promise<unknown>(() => {}) : locks.request(name, options, callback),
      },
      openChannel: () => new FakeChannel(bus),
      stamp: async () => 'stamped',
      visibility: () => 'visible',
      watchVisibility: () => () => {},
      watchPageLifecycle: () => {},
      session: () => null,
      local: () => null,
      reload,
    });
    try {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LOCK_REQUEST_SETTLE_MS + 10);
      });
      expect(appShown()).toBe(true);
      expect(locks.held.has(lockName)).toBe(true);
      expect(getVaultOwnershipState(userId)).toBe('owned');
    } finally {
      warn.mockRestore();
    }
  });

  it('a frozen owner: no reply in time, then "Take over anyway", saying a call there may end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const owner = ownerTab({ frozen: true });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await click('vaultOwnership.useHere');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWNER_REPLY_TIMEOUT_MS);
    });
    expect(text()).toContain('vaultOwnership.noReply');
    expect(text()).toContain('vaultOwnership.callPossible');
    expect(owner.lost()).toBe(false);

    await click('vaultOwnership.takeOverAnyway');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(owner.lost()).toBe(true);
    expect(locks.requests.at(-1)).toMatchObject({ steal: true });
    expect(appShown()).toBe(true);
  });

  it('the tab that gives the vault up: its call ends, its screen shows, and "Use it here" reloads to ask for it', async () => {
    voice.activeChannelId = 'voice-channel';
    mount();
    await settle();
    expect(appShown()).toBe(true);

    // another tab asks for it
    other.postMessage({ v: 1, type: 'query', vault: vaultKey, from: 'asker', nonce: 'q' });
    await settle();
    expect(other.received).toContainEqual({ v: 1, type: 'status', vault: vaultKey, to: 'asker', nonce: 'q', call: 'voice' });
    other.postMessage({ v: 1, type: 'release', vault: vaultKey, from: 'asker', nonce: 'r' });
    await settle();
    expect(voice.leaveChannel).toHaveBeenCalledTimes(1);
    expect(appShown()).toBe(false);
    expect(text()).toContain('vaultOwnership.lostTitle');
    expect(socket.state.holds).toBe(1);

    await click('vaultOwnership.useHere');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(session.get(TAKEOVER_INTENT_KEY) as string)).toMatchObject({ vault: vaultKey });
  });

  it('a tab loaded by "Use it here" asks the owner at once instead of showing the screen again', async () => {
    session.set(TAKEOVER_INTENT_KEY, JSON.stringify({ vault: vaultKey, at: Date.now() }));
    const owner = ownerTab({ call: 'dm' });
    mount();
    await settle();
    expect(other.received.map((m) => m.type)).toEqual(['query']);
    expect(text()).toContain('vaultOwnership.callWarning');
    await click('vaultOwnership.useHere');
    await settle();
    expect(owner.lost()).toBe(true);
    expect(appShown()).toBe(true);
    expect(session.has(TAKEOVER_INTENT_KEY)).toBe(false);
  });

  it('a waiting tab whose account was signed out meanwhile signs out instead of mounting the app', async () => {
    me.get.mockRejectedValue(Object.assign(new Error('401'), { response: { status: 401 } }));
    const owner = ownerTab();
    mount();
    await settle();
    owner.release();
    await settle();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    // the session the check was made with, never one another tab stored meanwhile
    expect(auth.logout).toHaveBeenCalledWith(expect.objectContaining({ endingSession: 'access-token' }));
    expect(appShown()).toBe(false);
  });

  it('without Web Locks, a start that lost to one written after it shows the screen, never the call warning', async () => {
    _setVaultOwnershipEnvironmentForTests({
      locks: null,
      openChannel: () => new FakeChannel(bus),
      stamp: async (_name, _token, mode) => {
        if (mode === 'keep') return 'other'; // read back: the token on disk is the other start's
        // the other start, written after this one, tells the tabs while this one writes
        other.postMessage({ v: 1, type: 'taken', vault: vaultKey, from: 'other-start' });
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        return 'stamped';
      },
      visibility: () => 'visible',
      watchVisibility: () => () => {},
      watchPageLifecycle: () => {},
      session: () => null,
      local: () => null,
      reload,
    });
    mount();
    await vi.waitFor(() => expect(text()).toContain('vaultOwnership.blockedTitle'));
    expect(text()).not.toContain('vaultOwnership.callWarning');
    expect(appShown()).toBe(false);
    expect(socket.state.holds).toBe(1);
  });

  it('a 401 to a session check sent with a token whose renewal had just failed is no refusal: asked again, nobody signed out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // what api.ts hands back when the access token had expired and its renewal
    // failed for a passing reason (a 429, a 5xx, the network): the request
    // went out with the stale token, marked so, and the server answered 401
    const staleToken = Object.assign(new Error('Request failed with status code 401'), {
      response: { status: 401 },
      config: { _renewalFailed: true },
    });
    me.get.mockRejectedValueOnce(staleToken).mockResolvedValue({ data: { data: { id: userId } } });
    try {
      const owner = ownerTab();
      mount();
      await settle();
      owner.release();
      await settle();
      expect(auth.logout).not.toHaveBeenCalled();
      expect(text()).toContain('vaultOwnership.opening');
      expect(appShown()).toBe(false);
      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });
      await settle();
      expect(me.get).toHaveBeenCalledTimes(2);
      expect(appShown()).toBe(true);
      expect(auth.logout).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([401, 403])('a plain %s to the session check signs the waiting tab out', async (status) => {
    me.get.mockRejectedValue(Object.assign(new Error(String(status)), { response: { status }, config: {} }));
    const owner = ownerTab();
    mount();
    await settle();
    owner.release();
    await settle();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(appShown()).toBe(false);
  });

  it('a waiting tab now signed in to another account reloads instead of mounting the app', async () => {
    me.get.mockResolvedValue({ data: { data: { id: 'someone-else' } } });
    const owner = ownerTab();
    mount();
    await settle();
    owner.release();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(appShown()).toBe(false);
  });

  it('answers which call runs here: a DM call before a voice channel', async () => {
    voice.dmCallConversationId = 'conversation';
    voice.activeChannelId = 'voice-channel';
    mount();
    await settle();
    other.postMessage({ v: 1, type: 'query', vault: vaultKey, from: 'asker', nonce: 'q1' });
    await settle();
    expect(other.received).toContainEqual(expect.objectContaining({ type: 'status', call: 'dm' }));
  });

  it('never starts a second acquisition when it mounts again (a remount, React\'s double mount)', async () => {
    ownerTab();
    mount();
    await settle();
    act(() => root.unmount());
    container.remove();
    mount();
    await settle();
    expect(text()).toContain('vaultOwnership.blockedTitle');
    expect(locks.requests.filter((r) => r.ifAvailable)).toHaveLength(1);
  });

  it('without Web Locks the newest start wins: the app mounts, and the other tabs are told', async () => {
    install({ locks: false });
    mount();
    // nobody answers its question first (FENCE_START_QUERY_MS)
    await vi.waitFor(() => expect(appShown()).toBe(true));
    expect(other.received.map((m) => m.type)).toEqual(['query', 'taken']);
  });

  it('without Web Locks, a call running in the tab that owns the vault is the person’s to end: the warning first, then the vault', async () => {
    install({ locks: false });
    other.onmessage = ({ data }) => {
      const m = data as Record<string, unknown>;
      if (m.type === 'query') other.postMessage({ v: 1, type: 'status', vault: vaultKey, to: m.from, nonce: m.nonce, call: 'voice' });
    };
    mount();
    await vi.waitFor(() => expect(text()).toContain('vaultOwnership.callWarning'));
    expect(appShown()).toBe(false);
    expect(other.received.map((m) => m.type)).toEqual(['query']); // nothing claimed: the other tab's call goes on
    expect(socket.state.holds).toBe(1);

    await click('vaultOwnership.cancel');
    expect(text()).toContain('vaultOwnership.blockedTitle');
    expect(text()).not.toContain('vaultOwnership.waitingNote'); // nothing waits without the lock

    await click('vaultOwnership.useHere');
    await vi.waitFor(() => expect(text()).toContain('vaultOwnership.callWarning'));
    await click('vaultOwnership.useHere'); // the confirmation
    await vi.waitFor(() => expect(appShown()).toBe(true));
    expect(other.received.map((m) => m.type)).toContain('taken');
  });

  it.each([
    ['before the page let the vault go', false],
    ['after the page let it go', true],
  ])('a sign-out and a sign-in back in this tab (%s): the app again, never the screen', async (_label, letGo) => {
    let signedIn: string | null = userId;
    registerE2ESessionUser(() => signedIn);
    try {
      mount();
      await settle();
      expect(appShown()).toBe(true);
      // sign-out: the app unmounts, the page lets the vault go once nothing uses it
      act(() => root.unmount());
      container.remove();
      signedIn = null;
      releaseVaultOwnershipNotInUse();
      if (letGo) {
        await settle();
        expect(getVaultOwnershipState(userId)).toBe('none');
      }
      signedIn = userId;
      const seen: string[] = [];
      mount();
      const watch = setInterval(() => seen.push(text()), 0);
      await settle();
      clearInterval(watch);
      expect(appShown()).toBe(true);
      expect(seen.some((t) => t.includes('vaultOwnership.'))).toBe(false);
      expect(socket.holdSocketConnections).not.toHaveBeenCalled();
    } finally {
      registerE2ESessionUser(null);
    }
  });

  it('waits a moment when it starts hidden in a browser, and not in the desktop app, whose window starts hidden', async () => {
    install({ hidden: true });
    mount();
    await settle();
    expect(appShown()).toBe(false); // a browser tab restored in the background asks later

    act(() => root.unmount());
    container.remove();
    _resetVaultOwnershipForTests();
    _resetVaultOwnershipGatesForTests();
    installVaultOwnershipHooks();
    install({ hidden: true });
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    try {
      mount();
      await settle();
      expect(appShown()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a waiting tab that cannot reach the server shows it is opening, and checks again as soon as the network is back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    me.get.mockRejectedValueOnce(new Error('Network Error')).mockResolvedValue({ data: { data: { id: userId } } });
    try {
      const owner = ownerTab();
      mount();
      await settle();
      owner.release();
      await settle();
      expect(text()).toContain('vaultOwnership.opening');
      expect(appShown()).toBe(false);
      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });
      await settle();
      expect(me.get).toHaveBeenCalledTimes(2);
      expect(appShown()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

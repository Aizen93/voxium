import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  handlers = new Map<string, Handler[]>();
  on(ev: string, fn: Handler) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); return this; }
  removeAllListeners() { this.handlers.clear(); }
  fire(ev: string, ...args: unknown[]) { (this.handlers.get(ev) ?? []).forEach((fn) => fn(...args)); }
}

class FakeSocket extends FakeEmitter {
  connected = false;
  auth: { token?: string };
  io = new FakeEmitter();
  connect = vi.fn(() => { this.connected = false; });
  disconnect = vi.fn();
  constructor(opts: { auth: { token: string } }) { super(); this.auth = opts.auth; }
}

const created: FakeSocket[] = [];
vi.mock('socket.io-client', () => ({
  io: (_url: string, opts: { auth: { token: string } }) => {
    const s = new FakeSocket(opts);
    created.push(s);
    return s;
  },
}));

const session = vi.hoisted(() => {
  class SessionLostError extends Error {}
  // Token equality stands in for the sid comparison (session.test.ts covers it)
  return {
    refreshAccessToken: vi.fn(), SessionLostError, sameSession: (a: string, b: string) => a === b,
    endSessionRenewals: vi.fn(), navigateOnce: vi.fn(),
  };
});
vi.mock('../../services/session', () => session);

// true: the stored pair was this socket's session (cleared); false: another session is stored
const endSessionLocally = vi.hoisted(() => vi.fn((_token?: string | null) => true));
const logout = vi.hoisted(() => vi.fn());
vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ endSessionLocally, logout }) },
}));

import {
  connectSocket, disconnectSocket, followStoredSession, _setSocketRandomForTests,
  HANDSHAKE_REFRESH_MIN_INTERVAL_MS, SERVER_DISCONNECT_REOPEN_MAX_DELAY_MS, STABLE_CONNECTION_MS,
} from '../../services/socket';
import { setTokens } from '../../services/tokenStorage';

function last(): FakeSocket {
  return created[created.length - 1];
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  endSessionLocally.mockImplementation(() => true);
  _setSocketRandomForTests(() => 0.5);
  created.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  disconnectSocket();
  vi.useRealTimers();
});

describe('admin socket handshake refusals', () => {
  it.each(['Session invalidated', 'Token expired', 'Invalid token'])(
    '%s: ONE renewal, then a reconnect with the new token',
    async (message) => {
      setTokens('A1', 'R1', true);
      connectSocket('A1');
      const s = last();
      session.refreshAccessToken.mockImplementation(async () => {
        setTokens('A2', 'R2');
        return 'A2';
      });
      s.fire('connect_error', new Error(message));
      await flush();
      expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
      expect(s.auth).toEqual({ token: 'A2' });
      expect(s.disconnect).toHaveBeenCalled();
      expect(s.connect).toHaveBeenCalledTimes(1);
    },
  );

  it('a second refusal of the token a renewal just gave renews nothing and retries with back-off', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    session.refreshAccessToken.mockImplementation(async () => {
      setTokens('A2', 'R2');
      return 'A2';
    });
    s.fire('connect_error', new Error('Session invalidated'));
    await flush();
    expect(s.connect).toHaveBeenCalledTimes(1);
    s.fire('connect_error', new Error('Session invalidated'));
    await flush();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(s.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.connect).toHaveBeenCalledTimes(2);
  });

  it('a refused renewal leaves the sign-in redirect to the session module and reconnects nothing', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    session.refreshAccessToken.mockRejectedValue(new session.SessionLostError('refused'));
    s.fire('connect_error', new Error('Session invalidated'));
    await flush();
    expect(s.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.connect).not.toHaveBeenCalled();
  });

  it('a renewal failing for a transport reason keeps the session and retries later', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    session.refreshAccessToken.mockRejectedValue(new Error('Network Error'));
    s.fire('connect_error', new Error('Token expired'));
    await flush();
    expect(s.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.connect).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('Authentication unavailable renews nothing and retries with doubling back-off', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    s.fire('connect_error', new Error('Authentication unavailable'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.connect).toHaveBeenCalledTimes(1);
    s.fire('connect_error', new Error('Authentication unavailable'));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(s.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.connect).toHaveBeenCalledTimes(2);
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('a token renewed meanwhile by a request is used without another renewal', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    setTokens('A2', 'R2');
    s.fire('connect_error', new Error('Token expired'));
    await flush();
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(s.auth).toEqual({ token: 'A2' });
    expect(s.connect).toHaveBeenCalledTimes(1);
  });

  it('other refusals and transport errors are left alone', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    for (const m of ['xhr poll error', 'Consent required', 'Email not verified']) {
      s.fire('connect_error', new Error(m));
    }
    await flush();
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(s.connect).not.toHaveBeenCalled();
  });

  it('a reconnect attempt uses the CURRENT stored access token', () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    setTokens('A9', 'R9');
    s.io.fire('reconnect_attempt');
    expect(s.auth).toEqual({ token: 'A9' });
  });
});

describe('admin socket handshake renewal window', () => {
  it('a token a renewal just gave, refused again after the window, is renewed once more', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    let n = 1;
    session.refreshAccessToken.mockImplementation(async () => {
      n++;
      setTokens(`A${n}`, `R${n}`);
      return `A${n}`;
    });
    s.fire('connect_error', new Error('Token expired'));
    await flush();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(s.auth).toEqual({ token: 'A2' });

    // Refused again within the window: no renewal, a retry with back-off
    s.fire('connect_error', new Error('Token expired'));
    await flush();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);

    // The window has passed (A2 may have expired meanwhile): one more renewal
    await vi.advanceTimersByTimeAsync(HANDSHAKE_REFRESH_MIN_INTERVAL_MS);
    s.fire('connect_error', new Error('Token expired'));
    await flush();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(s.auth).toEqual({ token: 'A3' });

    // ...and the new token has a window of its own
    s.fire('connect_error', new Error('Token expired'));
    await flush();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(2);
  });
});

describe('admin socket after a server disconnect', () => {
  function connected(s: FakeSocket) {
    s.connected = true;
    s.fire('connect');
  }
  function serverDisconnect(s: FakeSocket) {
    s.connected = false;
    s.fire('disconnect', 'io server disconnect');
  }
  // random() = 0.5: the spread adds half of SERVER_DISCONNECT_REOPEN_MAX_DELAY_MS
  const SPREAD = SERVER_DISCONNECT_REOPEN_MAX_DELAY_MS / 2;

  it('reopens after a spread wait, with the token stored THEN', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    connected(s);
    serverDisconnect(s);
    setTokens('A2', 'R2');
    await vi.advanceTimersByTimeAsync(SPREAD - 1);
    expect(s.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.auth).toEqual({ token: 'A2' });
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('a refused token on that reopen goes through the usual renewal', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    connected(s);
    serverDisconnect(s);
    await vi.advanceTimersByTimeAsync(SPREAD);
    expect(s.connect).toHaveBeenCalledTimes(1);
    session.refreshAccessToken.mockImplementation(async () => {
      setTokens('A2', 'R2');
      return 'A2';
    });
    s.fire('connect_error', new Error('Session invalidated'));
    await flush();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(s.auth).toEqual({ token: 'A2' });
    expect(s.connect).toHaveBeenCalledTimes(2);
  });

  it('never after a force:logout on that socket', async () => {
    setTokens('A1', 'R1', true);
    const realLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { set href(_v: string) { /* not read here */ } } });
    connectSocket('A1');
    const s = last();
    connected(s);
    s.fire('force:logout', { reason: 'Your account has been banned' });
    serverDisconnect(s);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.connect).not.toHaveBeenCalled();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('nothing after a local sign-out: disconnectSocket cancels the pending reopen', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    connected(s);
    serverDisconnect(s);
    disconnectSocket();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.connect).not.toHaveBeenCalled();
  });

  it('a transport loss is left to the manager', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    connected(s);
    s.connected = false;
    s.fire('disconnect', 'transport close');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.connect).not.toHaveBeenCalled();
  });

  it('a server that keeps disconnecting right after accepting is reopened ever more slowly; a bare connect does not reset that', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    const waits: number[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      connected(s);
      serverDisconnect(s);
      const before = s.connect.mock.calls.length;
      let waited = 0;
      while (s.connect.mock.calls.length === before && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      waits.push(waited);
    }
    // The spread, then the back-off on top: 2 s, 4 s, 8 s
    expect(waits).toEqual([SPREAD, 2_000 + SPREAD, 4_000 + SPREAD, 8_000 + SPREAD]);
  });

  it('a connection that stayed up resets that back-off', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    connected(s);
    serverDisconnect(s);
    await vi.advanceTimersByTimeAsync(SPREAD);
    connected(s);
    serverDisconnect(s);
    await vi.advanceTimersByTimeAsync(2_000 + SPREAD);
    expect(s.connect).toHaveBeenCalledTimes(2);
    connected(s);
    await vi.advanceTimersByTimeAsync(STABLE_CONNECTION_MS);
    serverDisconnect(s);
    await vi.advanceTimersByTimeAsync(SPREAD);
    expect(s.connect).toHaveBeenCalledTimes(3);
  });
});

describe('admin socket following another tab', () => {
  it('a pair of another session stored there moves the socket onto it', () => {
    setTokens('A-S', 'R-S', true);
    connectSocket('A-S');
    const s = last();
    s.connected = true;
    setTokens('A-M', 'R-M', true);
    followStoredSession();
    expect(s.auth).toEqual({ token: 'A-M' });
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(s.connect).toHaveBeenCalledTimes(1);
  });

  it('the same session stored there (a renewal) leaves the socket alone', () => {
    setTokens('A-S', 'R-S', true);
    connectSocket('A-S');
    const s = last();
    s.connected = true;
    followStoredSession();
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it('does nothing without a socket or without a stored token', () => {
    expect(() => followStoredSession()).not.toThrow();
    connectSocket('A-S');
    followStoredSession();
    expect(last().connect).not.toHaveBeenCalled();
  });
});

describe('admin socket force:logout', () => {
  const navigations = () => session.navigateOnce.mock.calls.map((c) => c[0]);

  it('signs out locally without the server call and keeps the reason in the sign-in address', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    last().fire('force:logout', { reason: 'Your session has ended' });
    await vi.waitFor(() => expect(session.navigateOnce).toHaveBeenCalledTimes(1));
    expect(endSessionLocally).toHaveBeenCalledTimes(1);
    // The session that ended is the one the socket handshook with
    expect(endSessionLocally).toHaveBeenCalledWith('A1');
    expect(logout).not.toHaveBeenCalled();
    expect(navigations()).toEqual(['/login?reason=Your%20session%20has%20ended']);
  });

  it('ends the renewals at once, before anything asynchronous runs', () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    last().fire('force:logout', { reason: 'Your session has ended' });
    // Synchronously: a request that comes back 401 from here on renews nothing
    expect(session.endSessionRenewals).toHaveBeenCalledTimes(1);
    expect(endSessionLocally).not.toHaveBeenCalled();
  });

  it('for a session that is no longer the stored one, reloads onto the stored session instead', async () => {
    setTokens('A-S', 'R-S', true);
    connectSocket('A-S');
    endSessionLocally.mockImplementation(() => false);
    last().fire('force:logout', { reason: 'Your session has ended' });
    await vi.waitFor(() => expect(session.navigateOnce).toHaveBeenCalledTimes(1));
    expect(endSessionLocally).toHaveBeenCalledWith('A-S');
    expect(navigations()).toEqual(['/']);
  });

  it('without a reason: the sign-in page alone', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    last().fire('force:logout', {});
    await vi.waitFor(() => expect(session.navigateOnce).toHaveBeenCalledTimes(1));
    expect(navigations()).toEqual(['/login']);
  });

  it('a local clean-up that throws is logged by message and still goes to the sign-in page', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setTokens('A-secret', 'R1', true);
    connectSocket('A-secret');
    endSessionLocally.mockImplementation(() => { throw new Error('clean-up failed'); });
    last().fire('force:logout', { reason: 'Your account has been deleted' });
    await vi.waitFor(() => expect(session.navigateOnce).toHaveBeenCalledTimes(1));
    expect(navigations()).toEqual(['/login?reason=Your%20account%20has%20been%20deleted']);
    expect(JSON.stringify(error.mock.calls)).toContain('clean-up failed');
    expect(JSON.stringify(error.mock.calls)).not.toContain('A-secret');
    error.mockRestore();
  });

  it('cancels a pending retry and a pending reopen, and follows no stored session afterwards', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    s.connected = true;
    s.fire('connect');
    // A reopen pending after a server disconnect, and a handshake retry pending
    s.connected = false;
    s.fire('disconnect', 'io server disconnect');
    s.fire('connect_error', new Error('Authentication unavailable'));
    const pending = vi.getTimerCount();
    s.fire('force:logout', { reason: 'Your session has ended' });
    expect(vi.getTimerCount()).toBe(pending - 2);
    setTokens('A-M', 'R-M', true);
    followStoredSession();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.disconnect).not.toHaveBeenCalled();
  });
});

describe('admin socket handshake refused for an account that is banned or gone', () => {
  const navigations = () => session.navigateOnce.mock.calls.map((c) => c[0]);

  it.each([
    ['Account banned', '/login?reason=Your%20account%20has%20been%20banned'],
    ['User not found', '/login?reason=Your%20account%20has%20been%20deleted'],
  ])('%s ends the session in this tab like a force:logout, without a renewal or a server call', async (message, href) => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    s.fire('connect_error', new Error(message));
    expect(session.endSessionRenewals).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(session.navigateOnce).toHaveBeenCalledTimes(1));
    expect(endSessionLocally).toHaveBeenCalledWith('A1');
    expect(logout).not.toHaveBeenCalled();
    expect(session.refreshAccessToken).not.toHaveBeenCalled();
    expect(navigations()).toEqual([href]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.connect).not.toHaveBeenCalled();
  });

  it('for a session that is no longer the stored one, reloads onto the stored session', async () => {
    setTokens('A-S', 'R-S', true);
    connectSocket('A-S');
    endSessionLocally.mockImplementation(() => false);
    last().fire('connect_error', new Error('Account banned'));
    await vi.waitFor(() => expect(session.navigateOnce).toHaveBeenCalledTimes(1));
    expect(navigations()).toEqual(['/']);
  });

  it('a second refusal after the first changes nothing more', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    s.fire('connect_error', new Error('Account banned'));
    s.fire('connect_error', new Error('User not found'));
    await vi.waitFor(() => expect(session.navigateOnce).toHaveBeenCalledTimes(1));
    await flush();
    expect(endSessionLocally).toHaveBeenCalledTimes(1);
    expect(session.endSessionRenewals).toHaveBeenCalledTimes(1);
  });
});

describe('what a connect resets', () => {
  it('the renewal window: a token refused again after a connect is renewed again at once', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    let n = 1;
    session.refreshAccessToken.mockImplementation(async () => {
      n++;
      setTokens(`A${n}`, `R${n}`);
      return `A${n}`;
    });
    s.fire('connect_error', new Error('Token expired'));
    await flush();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(1);
    // The new token connected, then the server refused it on a later handshake
    s.connected = true;
    s.fire('connect');
    s.connected = false;
    s.fire('connect_error', new Error('Token expired'));
    await flush();
    expect(session.refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(s.auth).toEqual({ token: 'A3' });
  });

  it('the retry back-off: after a connect, the next retry waits the shortest delay again', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    s.fire('connect_error', new Error('Authentication unavailable'));
    await vi.advanceTimersByTimeAsync(2_000);
    s.fire('connect_error', new Error('Authentication unavailable'));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.connect).toHaveBeenCalledTimes(2);
    s.connected = true;
    s.fire('connect');
    s.connected = false;
    s.fire('connect_error', new Error('Authentication unavailable'));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(s.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.connect).toHaveBeenCalledTimes(3);
  });

  it('a pending retry: a connect cancels it, also when the transport drops again before it was due', async () => {
    setTokens('A1', 'R1', true);
    connectSocket('A1');
    const s = last();
    s.fire('connect_error', new Error('Authentication unavailable'));
    s.connected = true;
    s.fire('connect');
    // A transport loss: the manager's to retry, not the stale timer's
    s.connected = false;
    s.fire('disconnect', 'transport close');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.connect).not.toHaveBeenCalled();
  });
});

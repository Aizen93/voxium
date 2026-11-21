import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAccessToken, getRefreshToken, setTokens, flushTokenStorage, hydrateTokens, announceSessionEnded,
  createKeychainSessionStore, reloadAfterSessionChange, SESSION_CHANNEL_NAME,
  _resetTokenStorageForTests, _setPageReloadForTests, _setSessionChannelForTests, type SessionChannel,
} from '../../services/tokenStorage';

// "Remember me" off keeps the pair in sessionStorage, one tab's own. A
// duplicated, restored or opener tab starts with a copy: two tabs on one
// session, kept in step by nothing. With every renewal replacing the refresh
// token, the tab that did not renew would present a replaced one. The tabs of
// one not-remembered session keep each other current on a BroadcastChannel.

const ACCESS = 'voxium_access_token';
const REFRESH = 'voxium_refresh_token';

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}
function pairOf(sid: string, gen: number, userId = 'user-x') {
  return { accessToken: jwt({ userId, sid, n: gen }), refreshToken: jwt({ userId, sid, gen }) };
}

/** What this page's channel posted, and a way to deliver another tab's message to it. */
function fakeChannel() {
  const posted: unknown[] = [];
  let opened = 0;
  let instance: SessionChannel | null = null;
  const factory = () => {
    opened++;
    instance = { postMessage: (m: unknown) => void posted.push(m), onmessage: null, close: vi.fn() };
    return instance;
  };
  return {
    factory,
    posted,
    opened: () => opened,
    deliver: (data: unknown) => instance?.onmessage?.({ data }),
  };
}

const reload = vi.fn();
let channel: ReturnType<typeof fakeChannel>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetTokenStorageForTests();
  _setPageReloadForTests(reload);
  reload.mockClear();
  channel = fakeChannel();
  _setSessionChannelForTests(channel.factory);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the not-remembered tabs of one session keep each other current', () => {
  it("every pair stored for a not-remembered session is posted as 'rotated', with its sid", () => {
    const p = pairOf('s-1', 2);
    setTokens(p.accessToken, p.refreshToken, false);

    expect(channel.posted).toEqual([{ type: 'rotated', sid: 's-1', accessToken: p.accessToken, refreshToken: p.refreshToken }]);
    expect(SESSION_CHANNEL_NAME).toBe('voxium-session');
  });

  it('nothing is posted for a remembered pair (other tabs follow the storage events) nor for a pair that names no session', () => {
    const p = pairOf('s-1', 2);
    setTokens(p.accessToken, p.refreshToken, true);
    setTokens('opaque-a', 'opaque-r', false);
    expect(channel.posted).toEqual([]);
  });

  it('nor for a pair whose access token names another session than its refresh token', () => {
    setTokens(pairOf('s-2', 1).accessToken, pairOf('s-1', 2).refreshToken, false);
    expect(channel.posted).toEqual([]);
  });

  it('a tab of the same session at a LOWER generation takes the pair, without posting it again', async () => {
    const mine = pairOf('s-1', 1);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    channel.posted.length = 0;

    const theirs = pairOf('s-1', 2);
    channel.deliver({ type: 'rotated', sid: 's-1', ...theirs });

    expect(getAccessToken()).toBe(theirs.accessToken);
    expect(getRefreshToken()).toBe(theirs.refreshToken);
    await flushTokenStorage();
    expect(sessionStorage.getItem(REFRESH)).toBe(theirs.refreshToken);
    expect(channel.posted).toEqual([]);
  });

  it('the same or a lower generation, another session, a mismatched pair or a malformed message: ignored', async () => {
    const mine = pairOf('s-1', 3);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();

    channel.deliver({ type: 'rotated', sid: 's-1', ...pairOf('s-1', 3) });
    channel.deliver({ type: 'rotated', sid: 's-1', ...pairOf('s-1', 2) });
    channel.deliver({ type: 'rotated', sid: 's-2', ...pairOf('s-2', 9) });
    channel.deliver({ type: 'rotated', sid: 's-1', accessToken: pairOf('s-2', 9).accessToken, refreshToken: pairOf('s-1', 9).refreshToken });
    channel.deliver({ type: 'rotated', sid: 's-1', accessToken: 'x'.repeat(5000), refreshToken: pairOf('s-1', 9).refreshToken });
    channel.deliver({ type: 'rotated', sid: 's-1' });
    channel.deliver('rotated');
    channel.deliver(null);

    expect(getRefreshToken()).toBe(mine.refreshToken);
  });

  it('a token longer than the cap is no token of ours, even one that names the session at a higher generation', async () => {
    const mine = pairOf('s-1', 3);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();

    const long = jwt({ userId: 'user-x', sid: 's-1', n: 9, pad: 'x'.repeat(5000) });
    expect(long.length).toBeGreaterThan(4096);
    channel.deliver({ type: 'rotated', sid: 's-1', accessToken: long, refreshToken: pairOf('s-1', 9).refreshToken });
    channel.deliver({ type: 'rotated', sid: 's-1', accessToken: pairOf('s-1', 9).accessToken, refreshToken: jwt({ userId: 'user-x', sid: 's-1', gen: 9, pad: 'x'.repeat(5000) }) });

    expect(getRefreshToken()).toBe(mine.refreshToken);
  });

  it('a tab whose pair names no session is never touched', async () => {
    sessionStorage.setItem(ACCESS, 'opaque-a');
    sessionStorage.setItem(REFRESH, 'opaque-r');
    await hydrateTokens();
    expect(channel.opened()).toBe(1);

    channel.deliver({ type: 'rotated', sid: 's-1', ...pairOf('s-1', 9) });
    channel.deliver({ type: 'ended', sid: 's-1' });
    expect(getRefreshToken()).toBe('opaque-r');
    expect(reload).not.toHaveBeenCalled();
  });

  it('a remembered tab ignores the channel it opened while its pair was not remembered', async () => {
    const before = pairOf('s-1', 1);
    setTokens(before.accessToken, before.refreshToken, false);
    expect(channel.opened()).toBe(1);
    const remembered = pairOf('s-1', 1);
    setTokens(remembered.accessToken, remembered.refreshToken, true);
    await flushTokenStorage();

    channel.deliver({ type: 'rotated', sid: 's-1', ...pairOf('s-1', 2) });
    channel.deliver({ type: 'ended', sid: 's-1' });

    expect(getRefreshToken()).toBe(remembered.refreshToken);
    expect(localStorage.getItem(REFRESH)).toBe(remembered.refreshToken);
    expect(reload).not.toHaveBeenCalled();
  });

  it('nothing is taken from the channel while the page reloads onto another session', async () => {
    const mine = pairOf('s-1', 1);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    reloadAfterSessionChange();

    channel.deliver({ type: 'rotated', sid: 's-1', ...pairOf('s-1', 2) });
    channel.deliver({ type: 'ended', sid: 's-1' });

    expect(getRefreshToken()).toBe(mine.refreshToken);
    await flushTokenStorage();
    expect(sessionStorage.getItem(REFRESH)).toBe(mine.refreshToken);
  });

  it("'ended' for this tab's session: its pair goes and the page reloads, signed out; another session's 'ended' changes nothing", async () => {
    const mine = pairOf('s-1', 2);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();

    channel.deliver({ type: 'ended', sid: 's-2' });
    expect(getRefreshToken()).toBe(mine.refreshToken);

    channel.deliver({ type: 'ended', sid: 's-1' });
    expect(getRefreshToken()).toBeNull();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(ACCESS)).toBeNull();
  });

  it("announceSessionEnded posts 'ended' with the sid only (never a token), and nothing for a token that names none", () => {
    announceSessionEnded(pairOf('s-1', 4).refreshToken);
    announceSessionEnded('opaque');
    announceSessionEnded(null);
    expect(channel.posted).toEqual([{ type: 'ended', sid: 's-1' }]);
  });

  it('a duplicated tab hears its twins from its start: the channel opens when it loads a not-remembered pair', async () => {
    const p = pairOf('s-1', 1);
    sessionStorage.setItem(ACCESS, p.accessToken);
    sessionStorage.setItem(REFRESH, p.refreshToken);
    expect(channel.opened()).toBe(0);

    await hydrateTokens();

    expect(channel.opened()).toBe(1);
    channel.deliver({ type: 'rotated', sid: 's-1', ...pairOf('s-1', 2) });
    expect(getRefreshToken()).toBe(pairOf('s-1', 2).refreshToken);
  });

  it('the desktop app opens no channel', async () => {
    const invoke = async <T>(): Promise<T> => null as T;
    _resetTokenStorageForTests(createKeychainSessionStore(invoke, { apiOrigin: 'https://voxium.app' }));
    _setSessionChannelForTests(channel.factory);
    await hydrateTokens();
    const p = pairOf('s-1', 2);
    setTokens(p.accessToken, p.refreshToken, false);
    announceSessionEnded(p.refreshToken);
    expect(channel.opened()).toBe(0);
  });

  it('a page without BroadcastChannel (or one that throws) just has no twins to tell', () => {
    _setSessionChannelForTests(null);
    const p = pairOf('s-1', 2);
    expect(() => setTokens(p.accessToken, p.refreshToken, false)).not.toThrow();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setSessionChannelForTests(() => { throw new Error('blocked'); });
    expect(() => setTokens(p.accessToken, p.refreshToken, false)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be opened'), 'blocked');
  });
});

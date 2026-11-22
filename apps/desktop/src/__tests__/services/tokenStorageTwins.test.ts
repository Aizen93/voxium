import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAccessToken, getRefreshToken, setTokens, flushTokenStorage, hydrateTokens, announceSessionEnded,
  createKeychainSessionStore, reloadAfterSessionChange, twinSyncPending, awaitTwinSync, SESSION_CHANNEL_NAME, TWIN_SYNC_WAIT_MS,
  TWIN_SYNC_ANSWER_INTERVAL_MS,
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
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(channel.opened()).toBe(0);
    expect(twinSyncPending()).toBe(false);
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

describe('a twin that missed the messages asks for the newest pair of its session', () => {
  /** A tab restored with its sessionStorage (Ctrl+Shift+T, a discarded tab reloaded): it loads this pair. */
  async function restoredWith(p: { accessToken: string; refreshToken: string }) {
    sessionStorage.setItem(ACCESS, p.accessToken);
    sessionStorage.setItem(REFRESH, p.refreshToken);
    await hydrateTokens();
  }
  const pageshow = (persisted: boolean) => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted }));

  it("a tab that loads a not-remembered pair asks with 'sync': the sid and its generation, never a token", async () => {
    await restoredWith(pairOf('s-1', 1));

    expect(channel.posted).toEqual([{ type: 'sync', sid: 's-1', gen: 1 }]);
    expect(twinSyncPending()).toBe(true);
  });

  it('a tab back from the back-forward cache asks again; a page shown for the first time does not ask twice', async () => {
    const mine = pairOf('s-1', 2);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    channel.posted.length = 0;

    pageshow(false);
    expect(channel.posted).toEqual([]);
    pageshow(true);
    expect(channel.posted).toEqual([{ type: 'sync', sid: 's-1', gen: 2 }]);
  });

  it('nothing is asked for a remembered pair, a pair that names no session, or one whose tokens name different sessions', async () => {
    const remembered = pairOf('s-1', 1);
    setTokens(remembered.accessToken, remembered.refreshToken, true);
    pageshow(true);
    setTokens('opaque-a', 'opaque-r', false);
    pageshow(true);
    setTokens(pairOf('s-2', 1).accessToken, pairOf('s-1', 1).refreshToken, false);
    pageshow(true);

    expect(channel.posted.filter((m) => (m as { type: string }).type === 'sync')).toEqual([]);
    expect(twinSyncPending()).toBe(false);
  });

  it('a twin that holds the session at a HIGHER generation answers with its pair, as rotated', async () => {
    const mine = pairOf('s-1', 3);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    channel.posted.length = 0;

    channel.deliver({ type: 'sync', sid: 's-1', gen: 1 });

    expect(channel.posted).toEqual([{ type: 'rotated', sid: 's-1', accessToken: mine.accessToken, refreshToken: mine.refreshToken }]);
    expect(getRefreshToken()).toBe(mine.refreshToken);
  });

  it('anything else is never answered: the same or a newer generation, another session, a malformed question', async () => {
    const mine = pairOf('s-1', 3);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    channel.posted.length = 0;

    channel.deliver({ type: 'sync', sid: 's-1', gen: 3 });
    channel.deliver({ type: 'sync', sid: 's-1', gen: 4 });
    channel.deliver({ type: 'sync', sid: 's-2', gen: 1 });
    channel.deliver({ type: 'sync', sid: 's-1' });
    channel.deliver({ type: 'sync', sid: 's-1', gen: '1' });
    channel.deliver({ type: 'sync', sid: 's-1', gen: -1 });
    channel.deliver({ type: 'sync', sid: 's-1', gen: 1.5 });
    channel.deliver({ type: 'sync', sid: 's-1', gen: 2 ** 40 });
    channel.deliver({ type: 'sync', sid: 'x'.repeat(5000), gen: 1 });
    channel.deliver({ type: 'sync', gen: 1 });

    expect(channel.posted).toEqual([]);
  });

  it('a remembered tab, a tab with no pair, and a page reloading onto another session answer nothing', async () => {
    const before = pairOf('s-1', 3);
    setTokens(before.accessToken, before.refreshToken, false); // the channel is open
    const remembered = pairOf('s-1', 3);
    setTokens(remembered.accessToken, remembered.refreshToken, true);
    await flushTokenStorage();
    channel.posted.length = 0;
    channel.deliver({ type: 'sync', sid: 's-1', gen: 1 });
    expect(channel.posted).toEqual([]);

    setTokens(before.accessToken, before.refreshToken, false);
    await flushTokenStorage();
    channel.posted.length = 0;
    reloadAfterSessionChange();
    channel.deliver({ type: 'sync', sid: 's-1', gen: 1 });
    expect(channel.posted).toEqual([]);
  });

  it('the answer is taken as the asking tab\'s pair, and the wait still runs its whole length', async () => {
    vi.useFakeTimers();
    await restoredWith(pairOf('s-1', 1));
    let waited = false;
    const wait = awaitTwinSync().then(() => { waited = true; });
    expect(twinSyncPending()).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    const theirs = pairOf('s-1', 3);
    channel.deliver({ type: 'rotated', sid: 's-1', ...theirs });
    await vi.advanceTimersByTimeAsync(0);
    expect(getRefreshToken()).toBe(theirs.refreshToken);
    // another twin may still answer with a newer generation
    expect(waited).toBe(false);

    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS - 10 - 1);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toBe(true);
    await wait;
    vi.useRealTimers();
  });

  it('twins at different generations all answer: the newest is held when the wait ends, whichever came first', async () => {
    vi.useFakeTimers();
    for (const order of [[5, 3], [3, 5]]) {
      _resetTokenStorageForTests();
      _setPageReloadForTests(reload);
      channel = fakeChannel();
      _setSessionChannelForTests(channel.factory);
      sessionStorage.clear();
      await restoredWith(pairOf('s-1', 1));
      const wait = awaitTwinSync();
      for (const gen of order) channel.deliver({ type: 'rotated', sid: 's-1', ...pairOf('s-1', gen) });
      await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS);
      await wait;
      expect(getRefreshToken(), order.join(',')).toBe(pairOf('s-1', 5).refreshToken);
    }
    vi.useRealTimers();
  });

  it('a rotated message that comes with no question asked neither starts nor ends a wait', async () => {
    vi.useFakeTimers();
    const mine = pairOf('s-1', 1);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    channel.deliver({ type: 'rotated', sid: 's-1', ...pairOf('s-1', 2) });
    expect(twinSyncPending()).toBe(false);
    let waited = false;
    void awaitTwinSync().then(() => { waited = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(waited).toBe(true);
    vi.useRealTimers();
  });

  it('nothing is asked while the page reloads onto another session', async () => {
    const mine = pairOf('s-1', 2);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    channel.posted.length = 0;
    reloadAfterSessionChange();

    pageshow(true);

    expect(channel.posted).toEqual([]);
    expect(twinSyncPending()).toBe(false);
  });

  it('with no channel nothing is asked, and no renewal waits', async () => {
    _setSessionChannelForTests(null);
    await restoredWith(pairOf('s-1', 1));
    expect(twinSyncPending()).toBe(false);
  });

  it(`a twin answers a question for its session at most once per ${TWIN_SYNC_ANSWER_INTERVAL_MS} ms; questions in between get one answer when it ends`, async () => {
    vi.useFakeTimers();
    const mine = pairOf('s-1', 3);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    channel.posted.length = 0;
    const answers = () => channel.posted.filter((m) => (m as { type: string }).type === 'rotated').length;

    channel.deliver({ type: 'sync', sid: 's-1', gen: 0 });
    expect(answers()).toBe(1);
    for (let i = 0; i < 5; i++) channel.deliver({ type: 'sync', sid: 's-1', gen: 0 });
    expect(answers()).toBe(1);
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_ANSWER_INTERVAL_MS - 1);
    expect(answers()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(answers()).toBe(2);
    // nothing more is owed: the next interval holds no answer
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_ANSWER_INTERVAL_MS * 3);
    expect(answers()).toBe(2);
    expect(TWIN_SYNC_ANSWER_INTERVAL_MS).toBeLessThan(TWIN_SYNC_WAIT_MS / 2);
    vi.useRealTimers();
  });

  it('the answer owed at the end of the interval is checked again then: none once the tab no longer holds a newer generation', async () => {
    vi.useFakeTimers();
    const mine = pairOf('s-1', 3);
    setTokens(mine.accessToken, mine.refreshToken, false);
    await flushTokenStorage();
    channel.deliver({ type: 'sync', sid: 's-1', gen: 1 });
    channel.posted.length = 0;
    channel.deliver({ type: 'sync', sid: 's-1', gen: 2 });
    // this tab holds another session before the interval ends: its pair answers no question about s-1
    const other = pairOf('s-2', 9);
    setTokens(other.accessToken, other.refreshToken, false);
    channel.posted.length = 0;
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_ANSWER_INTERVAL_MS);
    expect(channel.posted).toEqual([]);
    vi.useRealTimers();
  });

  it(`with no answer the renewal waits ${TWIN_SYNC_WAIT_MS} ms after the question, once`, async () => {
    vi.useFakeTimers();
    await restoredWith(pairOf('s-1', 1));
    let waited = false;
    void awaitTwinSync().then(() => { waited = true; });
    // a second wait while the first one runs waits for nothing
    let second = false;
    void awaitTwinSync().then(() => { second = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(true);

    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS - 1);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toBe(true);
    expect(TWIN_SYNC_WAIT_MS).toBeGreaterThanOrEqual(200);
    expect(TWIN_SYNC_WAIT_MS).toBeLessThanOrEqual(500);

    // a later renewal waits for nothing
    let again = false;
    void awaitTwinSync().then(() => { again = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBe(true);
    vi.useRealTimers();
  });

  it('a renewal long after the question waits for nothing more', async () => {
    vi.useFakeTimers();
    await restoredWith(pairOf('s-1', 1));
    await vi.advanceTimersByTimeAsync(TWIN_SYNC_WAIT_MS * 10);
    let waited = false;
    void awaitTwinSync().then(() => { waited = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(waited).toBe(true);
    vi.useRealTimers();
  });
});

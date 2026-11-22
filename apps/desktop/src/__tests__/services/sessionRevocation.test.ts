import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The server side of a sign-out: POST /auth/logout with the refresh token,
// fire-and-forget, retried in memory for a bounded time when it did not
// reach the server (the Cookie Policy quotes the bound). The first try is a
// keepalive fetch, which outlives the page; the later ones are axios calls.

const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => http.post(...args),
    isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean } | null)?.isAxiosError,
  },
}));

import {
  endSessionOnServer, holdReplacedSession, endReplacedSession, forgetReplacedSession,
  SIGN_OUT_REQUEST_TIMEOUT_MS, SIGN_OUT_RETRY_MAX_ENTRIES, SIGN_OUT_RETRY_MAX_AGE_MINUTES, SIGN_OUT_RETRY_MAX_AGE_MS,
  SIGN_OUT_RETRY_DELAYS_MS, _sessionRevocationStateForTests, _resetSessionRevocationForTests,
} from '../../services/sessionRevocation';
import * as limits from '../../services/sessionRevocationLimits';
import { API_BASE } from '../../services/apiBase';

const answered = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status } });
const noAnswer = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });
const timedOut = () => Object.assign(new Error('timeout of 10000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });

/** What `fetch` answers: a Response-like status, or a rejection (a TypeError is no answer at all). */
const fetchAnswer = (status: number) => Promise.resolve({ ok: status >= 200 && status < 300, status });
const fetchNoAnswer = () => Promise.reject(new TypeError('Failed to fetch'));
const fetchMock = vi.fn();

/** Every refresh token the queue sent, by either path, in the order they went out. */
function sentTokens(): string[] {
  const viaFetch = fetchMock.mock.calls.map((call, i) => ({
    order: fetchMock.mock.invocationCallOrder[i],
    token: (JSON.parse((call[1] as { body: string }).body) as { refreshToken: string }).refreshToken,
  }));
  const viaAxios = http.post.mock.calls.map((call, i) => ({
    order: http.post.mock.invocationCallOrder[i],
    token: (call[1] as { refreshToken: string }).refreshToken,
  }));
  return [...viaFetch, ...viaAxios].sort((a, b) => a.order - b.order).map((sent) => sent.token);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  http.post.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => fetchAnswer(204));
  vi.stubGlobal('fetch', fetchMock);
  _resetSessionRevocationForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  _resetSessionRevocationForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sessionRevocation — the constants the legal text quotes', () => {
  it('at most 3 waiting, 15 minutes each, retried after 5 s, 30 s, 2 min, 5 min, with a 10 s request deadline', () => {
    expect(SIGN_OUT_RETRY_MAX_ENTRIES).toBe(3);
    expect(SIGN_OUT_RETRY_MAX_AGE_MINUTES).toBe(15);
    expect(SIGN_OUT_RETRY_MAX_AGE_MS).toBe(15 * 60_000);
    expect(SIGN_OUT_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000, 300_000]);
    expect(SIGN_OUT_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('the bound is the one the limits module defines (the legal pages read it there)', () => {
    expect(SIGN_OUT_RETRY_MAX_AGE_MINUTES).toBe(limits.SIGN_OUT_RETRY_MAX_AGE_MINUTES);
    expect(SIGN_OUT_RETRY_MAX_AGE_MS).toBe(limits.SIGN_OUT_RETRY_MAX_AGE_MS);
  });
});

describe('sessionRevocation — endSessionOnServer', () => {
  it('first posts the refresh token with a fetch that outlives the page (keepalive), returning at once', () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));

    expect(endSessionOnServer('refresh-1')).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/auth/logout`);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'refresh-1' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init).sort()).toEqual(['body', 'headers', 'keepalive', 'method', 'signal']);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('the first try has the same 10 s deadline: past it the fetch is aborted and the sign-out tried again later', async () => {
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    }));
    http.post.mockResolvedValueOnce({ status: 204 });
    endSessionOnServer('refresh-1');

    await vi.advanceTimersByTimeAsync(SIGN_OUT_REQUEST_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(_sessionRevocationStateForTests().waiting).toBe(1);

    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_DELAYS_MS[0]);
    expect(http.post).toHaveBeenCalledWith(`${API_BASE}/auth/logout`, { refreshToken: 'refresh-1' }, { timeout: SIGN_OUT_REQUEST_TIMEOUT_MS });
    expect(_sessionRevocationStateForTests().waiting).toBe(0);
  });

  it('a page without fetch sends its first try with a plain axios call', () => {
    vi.stubGlobal('fetch', undefined);
    http.post.mockReturnValueOnce(new Promise(() => {}));

    endSessionOnServer('refresh-1');

    expect(http.post).toHaveBeenCalledWith(`${API_BASE}/auth/logout`, { refreshToken: 'refresh-1' }, { timeout: SIGN_OUT_REQUEST_TIMEOUT_MS });
  });

  it('a no-op without a token, and for a token already waiting', async () => {
    endSessionOnServer(null);
    endSessionOnServer(undefined);
    endSessionOnServer('');
    expect(sentTokens()).toEqual([]);

    fetchMock.mockImplementation(fetchNoAnswer);
    endSessionOnServer('refresh-1');
    await vi.advanceTimersByTimeAsync(0);
    endSessionOnServer('refresh-1');
    expect(sentTokens()).toEqual(['refresh-1']);
    expect(_sessionRevocationStateForTests().waiting).toBe(1);
  });

  it('the 204 (and any other answer but a 429 or a 5xx: an older server\'s 404, a 400) ends it: nothing waits', async () => {
    for (const status of [204, 404, 400, 401]) {
      fetchMock.mockImplementationOnce(() => fetchAnswer(status));
      endSessionOnServer(`refresh-${status}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(_sessionRevocationStateForTests().waiting).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('a 429 or a 5xx to the first try is tried again, like no answer at all', async () => {
    for (const status of [429, 500, 503]) {
      _resetSessionRevocationForTests();
      http.post.mockReset();
      fetchMock.mockImplementationOnce(() => fetchAnswer(status));
      http.post.mockResolvedValueOnce({ status: 204 });
      endSessionOnServer(`refresh-${status}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(_sessionRevocationStateForTests().waiting).toBe(1);
      await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_DELAYS_MS[0]);
      expect(http.post).toHaveBeenCalledTimes(1);
      expect(_sessionRevocationStateForTests().waiting).toBe(0);
    }
  });

  it('no answer, a timeout, a 429 or a 5xx: tried again after 5 s, 30 s, 2 min, 5 min, then every 5 min', async () => {
    fetchMock.mockImplementationOnce(fetchNoAnswer);
    http.post
      .mockRejectedValueOnce(timedOut())
      .mockRejectedValueOnce(answered(429))
      .mockRejectedValueOnce(answered(503))
      .mockRejectedValueOnce(answered(500))
      .mockResolvedValueOnce({ status: 204 });
    endSessionOnServer('refresh-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentTokens()).toHaveLength(1);

    const expectAfter = async (ms: number, calls: number) => {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(sentTokens()).toHaveLength(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sentTokens()).toHaveLength(calls);
    };
    await expectAfter(5_000, 2);
    await expectAfter(30_000, 3);
    await expectAfter(120_000, 4);
    await expectAfter(300_000, 5);
    await expectAfter(300_000, 6);
    expect(_sessionRevocationStateForTests().waiting).toBe(0);
    // the first try went out with fetch, every later one with axios
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledTimes(5);
    // every request carried the same token, and nothing logged it
    expect(new Set(sentTokens())).toEqual(new Set(['refresh-1']));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('refresh-1');
  });

  it('the network coming back retries every waiting sign-out at once', async () => {
    fetchMock.mockImplementationOnce(fetchNoAnswer);
    http.post.mockResolvedValueOnce({ status: 204 });
    endSessionOnServer('refresh-1');
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(sentTokens()).toHaveLength(2);
    expect(_sessionRevocationStateForTests().waiting).toBe(0);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    expect(sentTokens()).toHaveLength(2);
  });

  it('is given up 15 minutes after the sign-out, whatever is still pending', async () => {
    fetchMock.mockImplementation(fetchNoAnswer);
    http.post.mockRejectedValue(noAnswer());
    endSessionOnServer('refresh-1');
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS - 1);
    expect(_sessionRevocationStateForTests().waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(_sessionRevocationStateForTests().waiting).toBe(0);
    const calls = sentTokens().length;
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    window.dispatchEvent(new Event('online'));
    expect(sentTokens()).toHaveLength(calls);
  });

  it('at most 3 wait at once: a fourth pushes the oldest out', async () => {
    fetchMock.mockImplementation(fetchNoAnswer);
    http.post.mockRejectedValue(noAnswer());
    for (const token of ['r-1', 'r-2', 'r-3', 'r-4']) endSessionOnServer(token);
    await vi.advanceTimersByTimeAsync(0);
    expect(_sessionRevocationStateForTests().waiting).toBe(3);

    http.post.mockClear();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(http.post.mock.calls.map((c) => (c[1] as { refreshToken: string }).refreshToken)).toEqual(['r-2', 'r-3', 'r-4']);
  });

  it('the page going away drops everything waiting, and leaves the first try in flight to the browser', async () => {
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise(() => {});
    });
    endSessionOnServer('refresh-1');
    holdReplacedSession('refresh-stale');
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event('pagehide'));

    expect(_sessionRevocationStateForTests()).toEqual({ waiting: 0, replacedHeld: false });
    // the keepalive request is the browser's to carry on: going away aborts nothing
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    expect(sentTokens()).toEqual(['refresh-1']);
  });
});

describe('sessionRevocation — the session a sign-in replaces', () => {
  it('is ended on the server only once the new sign-in succeeded, and never when it is the new token', async () => {
    holdReplacedSession('refresh-stale');
    expect(sentTokens()).toEqual([]);

    endReplacedSession('refresh-new');
    expect(sentTokens()).toEqual(['refresh-stale']);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/auth/logout`, expect.objectContaining({ keepalive: true }));

    holdReplacedSession('refresh-same');
    endReplacedSession('refresh-same');
    expect(sentTokens()).toHaveLength(1);
  });

  it('a null token keeps the one an earlier step held (a registration discards at both of its steps)', () => {
    holdReplacedSession('refresh-stale');
    holdReplacedSession(null);
    endReplacedSession('refresh-new');
    expect(sentTokens()).toEqual(['refresh-stale']);
  });

  it('is held at most 15 minutes, and forgetReplacedSession drops it: a later success sends nothing', async () => {
    holdReplacedSession('refresh-stale');
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    endReplacedSession('refresh-new');

    holdReplacedSession('refresh-stale-2');
    forgetReplacedSession();
    endReplacedSession('refresh-new-2');

    expect(sentTokens()).toEqual([]);
  });
});

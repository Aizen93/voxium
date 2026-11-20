import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The server side of a sign-out: POST /auth/logout with the refresh token,
// fire-and-forget, retried in memory for a bounded time when it did not
// reach the server (the Cookie Policy quotes the bound).

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
import { API_BASE } from '../../services/apiBase';

const answered = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status } });
const noAnswer = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });
const timedOut = () => Object.assign(new Error('timeout of 10000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  http.post.mockReset();
  _resetSessionRevocationForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  _resetSessionRevocationForTests();
  vi.useRealTimers();
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
});

describe('sessionRevocation — endSessionOnServer', () => {
  it('posts the refresh token to the logout route with a plain axios call and a 10 s deadline, returning at once', () => {
    http.post.mockReturnValueOnce(new Promise(() => {}));

    expect(endSessionOnServer('refresh-1')).toBeUndefined();

    expect(http.post).toHaveBeenCalledWith(`${API_BASE}/auth/logout`, { refreshToken: 'refresh-1' }, { timeout: SIGN_OUT_REQUEST_TIMEOUT_MS });
  });

  it('a no-op without a token, and for a token already waiting', async () => {
    endSessionOnServer(null);
    endSessionOnServer(undefined);
    endSessionOnServer('');
    expect(http.post).not.toHaveBeenCalled();

    http.post.mockRejectedValue(noAnswer());
    endSessionOnServer('refresh-1');
    await vi.advanceTimersByTimeAsync(0);
    endSessionOnServer('refresh-1');
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(_sessionRevocationStateForTests().waiting).toBe(1);
  });

  it('the 204 (and any other answer but a 429 or a 5xx: an older server\'s 404, a 400) ends it: nothing waits', async () => {
    for (const outcome of [() => Promise.resolve({ status: 204 }), () => Promise.reject(answered(404)), () => Promise.reject(answered(400)), () => Promise.reject(answered(401))]) {
      http.post.mockImplementationOnce(outcome);
      endSessionOnServer(`refresh-${http.post.mock.calls.length}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(_sessionRevocationStateForTests().waiting).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    expect(http.post).toHaveBeenCalledTimes(4);
  });

  it('no answer, a timeout, a 429 or a 5xx: tried again after 5 s, 30 s, 2 min, 5 min, then every 5 min', async () => {
    http.post
      .mockRejectedValueOnce(noAnswer())
      .mockRejectedValueOnce(timedOut())
      .mockRejectedValueOnce(answered(429))
      .mockRejectedValueOnce(answered(503))
      .mockRejectedValueOnce(answered(500))
      .mockResolvedValueOnce({ status: 204 });
    endSessionOnServer('refresh-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(http.post).toHaveBeenCalledTimes(1);

    const expectAfter = async (ms: number, calls: number) => {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(http.post).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(http.post).toHaveBeenCalledTimes(calls);
    };
    await expectAfter(5_000, 2);
    await expectAfter(30_000, 3);
    await expectAfter(120_000, 4);
    await expectAfter(300_000, 5);
    await expectAfter(300_000, 6);
    expect(_sessionRevocationStateForTests().waiting).toBe(0);
    // every request carried the same token, and nothing logged it
    expect(new Set(http.post.mock.calls.map((c) => (c[1] as { refreshToken: string }).refreshToken))).toEqual(new Set(['refresh-1']));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('refresh-1');
  });

  it('the network coming back retries every waiting sign-out at once', async () => {
    http.post.mockRejectedValueOnce(noAnswer()).mockResolvedValueOnce({ status: 204 });
    endSessionOnServer('refresh-1');
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(http.post).toHaveBeenCalledTimes(2);
    expect(_sessionRevocationStateForTests().waiting).toBe(0);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('is given up 15 minutes after the sign-out, whatever is still pending', async () => {
    http.post.mockRejectedValue(noAnswer());
    endSessionOnServer('refresh-1');
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS - 1);
    expect(_sessionRevocationStateForTests().waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(_sessionRevocationStateForTests().waiting).toBe(0);
    const calls = http.post.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    window.dispatchEvent(new Event('online'));
    expect(http.post).toHaveBeenCalledTimes(calls);
  });

  it('at most 3 wait at once: a fourth pushes the oldest out', async () => {
    http.post.mockRejectedValue(noAnswer());
    for (const token of ['r-1', 'r-2', 'r-3', 'r-4']) endSessionOnServer(token);
    await vi.advanceTimersByTimeAsync(0);
    expect(_sessionRevocationStateForTests().waiting).toBe(3);

    http.post.mockClear();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(http.post.mock.calls.map((c) => (c[1] as { refreshToken: string }).refreshToken)).toEqual(['r-2', 'r-3', 'r-4']);
  });

  it('the page going away drops everything: nothing outlives it', async () => {
    http.post.mockRejectedValue(noAnswer());
    endSessionOnServer('refresh-1');
    holdReplacedSession('refresh-stale');
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event('pagehide'));

    expect(_sessionRevocationStateForTests()).toEqual({ waiting: 0, replacedHeld: false });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

});

describe('sessionRevocation — the session a sign-in replaces', () => {
  it('is ended on the server only once the new sign-in succeeded, and never when it is the new token', async () => {
    http.post.mockResolvedValue({ status: 204 });
    holdReplacedSession('refresh-stale');
    expect(http.post).not.toHaveBeenCalled();

    endReplacedSession('refresh-new');
    expect(http.post).toHaveBeenCalledWith(`${API_BASE}/auth/logout`, { refreshToken: 'refresh-stale' }, { timeout: SIGN_OUT_REQUEST_TIMEOUT_MS });

    holdReplacedSession('refresh-same');
    endReplacedSession('refresh-same');
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a null token keeps the one an earlier step held (a registration discards at both of its steps)', () => {
    http.post.mockResolvedValue({ status: 204 });
    holdReplacedSession('refresh-stale');
    holdReplacedSession(null);
    endReplacedSession('refresh-new');
    expect(http.post).toHaveBeenCalledWith(expect.any(String), { refreshToken: 'refresh-stale' }, expect.any(Object));
  });

  it('is held at most 15 minutes, and forgetReplacedSession drops it: a later success sends nothing', async () => {
    holdReplacedSession('refresh-stale');
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MAX_AGE_MS);
    endReplacedSession('refresh-new');

    holdReplacedSession('refresh-stale-2');
    forgetReplacedSession();
    endReplacedSession('refresh-new-2');

    expect(http.post).not.toHaveBeenCalled();
  });
});

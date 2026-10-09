import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowExpiredError, PowAbortedError, type PowChallenge } from '@voxium/shared';
import { solveRegistrationPowOffThread } from '../../services/powSolver';

// The solve itself is exercised against the real shared solver in the server
// suite (registrationPow.test.ts round-trips issue → solve → verify). What is
// worth pinning HERE is the wrapper's contract: progress is forwarded, the
// worker is always terminated, and a missing/broken Worker still registers.

const CHALLENGE: PowChallenge = {
  // difficulty 1 so the in-thread fallback finishes in a handful of digests
  challenge: 'a'.repeat(32),
  difficulty: 1,
  expires: Date.now() + 60_000,
  sig: 'f'.repeat(64),
};

type Listener = (event: unknown) => void;

/** Minimal scriptable Worker double: `script` runs on the first postMessage. */
function installWorker(script: (post: (msg: unknown) => void, fail: (message: string) => void) => void) {
  const terminate = vi.fn();
  class FakeWorker {
    private listeners: Record<string, Listener[]> = {};
    terminate = terminate;
    addEventListener(type: string, cb: Listener) {
      (this.listeners[type] ||= []).push(cb);
    }
    postMessage() {
      const emit = (type: string, event: unknown) => {
        for (const cb of this.listeners[type] || []) cb(event);
      };
      script(
        (msg) => emit('message', { data: msg }),
        (message) => emit('error', { message }),
      );
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  return { terminate };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('powSolver — off-thread registration proof of work', () => {
  it('forwards a clamped progress fraction and resolves with the worker solution', async () => {
    const { terminate } = installWorker((post) => {
      post({ op: 'progress', attempts: 512, expected: 1024 });
      // Geometric distribution: a solve legitimately runs past its expected
      // attempt count, and the bar must never report more than 100%.
      post({ op: 'progress', attempts: 4096, expected: 1024 });
      post({ op: 'solved', solution: { ...CHALLENGE, nonce: '7' } });
    });

    const seen: number[] = [];
    const solution = await solveRegistrationPowOffThread(CHALLENGE, (f) => seen.push(f));

    expect(solution.nonce).toBe('7');
    expect(seen).toEqual([0.5, 1]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('rebuilds PowExpiredError across the worker boundary so the caller can refetch', async () => {
    const { terminate } = installWorker((post) => {
      post({ op: 'error', message: 'Registration challenge expired before it was solved', expired: true });
    });

    await expect(solveRegistrationPowOffThread(CHALLENGE)).rejects.toBeInstanceOf(PowExpiredError);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects — and does not hang — when the worker dies mid-solve', async () => {
    // It reported progress first, so the worker demonstrably RAN: this is a
    // crashed renderer or an OOM, and there is nothing to fall back to that
    // would not just crash again.
    const { terminate } = installWorker((post, fail) => {
      post({ op: 'progress', attempts: 512, expected: 1024 });
      fail('worker crashed');
    });

    await expect(solveRegistrationPowOffThread(CHALLENGE)).rejects.toThrow('worker crashed');
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('falls back in-thread when the worker never LOADS, instead of failing registration', async () => {
    // `new Worker(...)` succeeds and the module fetch then fails — a hashed
    // chunk missing after a redeploy, a filtering proxy, a content blocker. The
    // error arrives asynchronously, long after spawnWorker's try/catch could
    // see it, and rejecting here made registration impossible on that browser
    // forever even though the identical solver runs fine on the main thread.
    const { terminate } = installWorker((_post, fail) => fail(''));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const solution = await solveRegistrationPowOffThread(CHALLENGE);

    expect(Number(solution.nonce)).toBeGreaterThanOrEqual(0);
    expect(solution.challenge).toBe(CHALLENGE.challenge);
    expect(warn).toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight worker solve and terminates it', async () => {
    // Leaving the register view must stop the solve: otherwise it finishes in
    // the background, POSTs, and signs the user into the account they walked
    // away from — while a worker keeps burning a core.
    const { terminate } = installWorker((post) => {
      post({ op: 'progress', attempts: 1, expected: 1024 });
      // ...and never solves
    });
    const controller = new AbortController();

    const pending = solveRegistrationPowOffThread(CHALLENGE, undefined, controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(PowAbortedError);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('refuses immediately when handed an already-aborted signal', async () => {
    const { terminate } = installWorker((post) => post({ op: 'solved', solution: { ...CHALLENGE, nonce: '1' } }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      solveRegistrationPowOffThread(CHALLENGE, undefined, controller.signal),
    ).rejects.toBeInstanceOf(PowAbortedError);
    // Never even spawned — nothing to terminate
    expect(terminate).not.toHaveBeenCalled();
  });

  it('honours the signal on the in-thread path too, where the loop IS the main thread', async () => {
    vi.stubGlobal('Worker', undefined);
    const controller = new AbortController();
    controller.abort();

    await expect(
      // difficulty 24 would grind for minutes if the signal were ignored
      solveRegistrationPowOffThread({ ...CHALLENGE, difficulty: 24 }, undefined, controller.signal),
    ).rejects.toBeInstanceOf(PowAbortedError);
  });

  it('still solves in-thread when Worker is unavailable', async () => {
    // Hardened CSP / embedded webview / Node: registration must still work,
    // just without progress reporting.
    vi.stubGlobal('Worker', undefined);
    const onProgress = vi.fn();

    const solution = await solveRegistrationPowOffThread(CHALLENGE, onProgress);

    expect(Number(solution.nonce)).toBeGreaterThanOrEqual(0);
    expect(solution.challenge).toBe(CHALLENGE.challenge);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('falls back in-thread when Worker construction throws', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked by CSP'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const solution = await solveRegistrationPowOffThread(CHALLENGE);

    expect(Number(solution.nonce)).toBeGreaterThanOrEqual(0);
    expect(warn).toHaveBeenCalled();
  });
});

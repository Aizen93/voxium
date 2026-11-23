import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const redisSet = vi.fn();
vi.mock('../../utils/redis', () => ({
  getRedis: () => ({ set: redisSet }),
}));

import { issueRegistrationChallenge, verifyRegistrationPow, baseDifficulty } from '../../utils/registrationPow';
import {
  solveRegistrationPow,
  PowExpiredError,
  powExpectedAttempts,
  POW_MAX_DIFFICULTY,
  POW_CHALLENGE_TTL_MS,
} from '@voxium/shared';

const IP = '203.0.113.9';

/**
 * The two clock tests below walk the solver's loop past its deadline checks,
 * which sit every 4096 nonces. With the real digest that is thousands of
 * sequential WebCrypto calls (each one a hop to the thread pool), a cost that
 * grows with how busy the machine is and ended in the default test timeout. What
 * they assert is the solver's decisions about the clock, never a hash, so the
 * digest is replaced by one that never clears the target (a first byte of 0xff:
 * no leading zero bit): the loop is the real one and runs the same number of
 * rounds on every machine, in milliseconds. The call count it returns is
 * asserted, which also pins WHERE the deadline checks sit.
 */
function neverSolvingDigest() {
  const never = new Uint8Array(32).fill(0xff);
  return vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async () => never.buffer.slice(0));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret-for-pow-hmac-derivation';
  redisSet.mockResolvedValue('OK'); // NX succeeded — first redemption
});

// A failed assertion must not leave the clock or the digest replaced
afterEach(() => { vi.restoreAllMocks(); });

describe('registration proof-of-work', () => {
  it('round-trips: issue → solve (shared solver) → verify', async () => {
    const challenge = issueRegistrationChallenge(IP, 0);
    // Non-production issues a tiny difficulty — suites pay microseconds
    // through the exact production code path
    expect(challenge.difficulty).toBe(baseDifficulty());

    const solution = await solveRegistrationPow(challenge);
    await expect(verifyRegistrationPow(IP, solution)).resolves.toBeUndefined();
  });

  it('difficulty scales with subnet pressure and is capped', () => {
    const calm = issueRegistrationChallenge(IP, 0);
    const busy = issueRegistrationChallenge(IP, 3);
    const extreme = issueRegistrationChallenge(IP, 999);
    expect(busy.difficulty).toBeGreaterThan(calm.difficulty);
    expect(extreme.difficulty).toBe(POW_MAX_DIFFICULTY);
    // Never issue past the ceiling no matter how absurd the pressure input
    for (const pressure of [4, 10, 100, Number.MAX_SAFE_INTEGER]) {
      expect(issueRegistrationChallenge(IP, pressure).difficulty).toBeLessThanOrEqual(POW_MAX_DIFFICULTY);
    }
  });

  // F1: the ceiling used to be 24 bits against a 5-minute window, which a
  // phone cannot clear — a third of solves expired even at Node speed. This
  // is the guard that stops a future difficulty bump from silently reopening
  // it: the SLOWEST device we are willing to support must clear the HARDEST
  // issuable challenge well inside the window.
  it('the hardest issuable challenge is solvable by a slow device inside the TTL', () => {
    const PESSIMISTIC_DIGESTS_PER_SEC = 8_000; // low-end phone WebCrypto, deliberately under-measured
    const meanSolveMs = (powExpectedAttempts(POW_MAX_DIFFICULTY) / PESSIMISTIC_DIGESTS_PER_SEC) * 1000;
    // Solve time is geometric, so budget several means — the tail, not the
    // average, is what decides whether real users get in.
    expect(meanSolveMs * 4).toBeLessThan(POW_CHALLENGE_TTL_MS);
  });

  it('does NOT refuse a challenge that only the CLIENT clock thinks is expired', async () => {
    // The deadline is elapsed local time, not a comparison against the
    // server's absolute `expires`. A device whose clock runs fast would
    // otherwise be unable to register at all: bail before nonce 0, refetch,
    // bail again — while the server, judging by its own clock, would have
    // accepted the solve.
    const skewed = { ...issueRegistrationChallenge(IP, 0), expires: Date.now() - 60_000 };
    await expect(solveRegistrationPow(skewed)).resolves.toMatchObject({ challenge: skewed.challenge });
  });

  it('does not let a fast clock SHORTEN the solve budget either', async () => {
    // Deriving budgetMs from `expires - now` smuggles the server's clock back
    // in even though the check itself is local: a device twelve minutes fast
    // gets a three-minute window instead of fifteen and abandons solves the
    // server would have taken. It was not even monotonic — skew past the whole
    // TTL made the difference negative and restored the FULL budget, so a mild
    // clock error was punished harder than an absurd one.
    const challenge = {
      challenge: '00000000000000000000000000000001',
      difficulty: POW_MAX_DIFFICULTY,
      // What a client 12 minutes fast computes for a freshly issued challenge
      expires: Date.now() + POW_CHALLENGE_TTL_MS - 12 * 60_000,
      sig: 'f'.repeat(64),
    };
    const startedAt = Date.now();
    let checks = 0;
    // Call 1 is `startedAt`. Call 2 is the in-loop deadline check at nonce
    // 4096: elapsed sits just INSIDE the real 15-minute budget, but far past
    // the ~3 minutes the old code derived from `expires`. Call 3 pushes past
    // the real budget so the solve terminates instead of grinding.
    const digest = neverSolvingDigest();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      checks++;
      if (checks <= 1) return startedAt;
      if (checks === 2) return startedAt + POW_CHALLENGE_TTL_MS - 1_000;
      return startedAt + POW_CHALLENGE_TTL_MS + 1;
    });

    await expect(solveRegistrationPow(challenge)).rejects.toBeInstanceOf(PowExpiredError);
    // The decisive assertion: it survived the FIRST in-loop check. Deriving the
    // budget from `expires` would have bailed there, at checks === 2.
    expect(checks).toBeGreaterThanOrEqual(3);
    // ... and it bailed at the SECOND in-loop check, nonce 8192 (nonces 0..8192)
    // 2 x DEADLINE_CHECK_EVERY (packages/shared/src/pow.ts, 4096) + 1: update with it
    expect(digest).toHaveBeenCalledTimes(8193);

    clock.mockRestore();
    digest.mockRestore();
  });

  it('abandons a challenge whose deadline passes MID-solve', async () => {
    // Deterministic by construction, not by timing: the digest never clears the
    // target (see neverSolvingDigest), so the in-loop deadline check at nonce
    // 4096 is always reached first. The clock is stubbed to cross the deadline
    // exactly between the pre-flight check and that first in-loop one.
    const challenge = {
      challenge: '00000000000000000000000000000001',
      difficulty: POW_MAX_DIFFICULTY,
      expires: Date.now() + 60_000,
      sig: 'f'.repeat(64),
    };
    const startedAt = Date.now();
    let checks = 0;
    const digest = neverSolvingDigest();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() =>
      ++checks <= 1 ? startedAt : startedAt + POW_CHALLENGE_TTL_MS + 1);

    await expect(solveRegistrationPow(challenge)).rejects.toBeInstanceOf(PowExpiredError);
    expect(checks).toBeGreaterThan(1); // it really did start solving
    // It stopped at the first in-loop check, nonce 4096 (nonces 0..4096)
    // DEADLINE_CHECK_EVERY (packages/shared/src/pow.ts, 4096) + 1: update with it
    expect(digest).toHaveBeenCalledTimes(4097);

    clock.mockRestore();
    digest.mockRestore();
  });

  it('reports progress without a worker — the Node path stays a plain async call', async () => {
    // e2e helpers and scripts/load-test-voice.ts call this directly under Node
    const seen: number[] = [];
    const solution = await solveRegistrationPow(issueRegistrationChallenge(IP, 0), {
      batchSize: 1,
      onProgress: (attempts) => { seen.push(attempts); },
    });
    await expect(verifyRegistrationPow(IP, solution)).resolves.toBeUndefined();
    // Progress is best-effort: a one-shot solve legitimately reports nothing
    expect(seen.every((n, i) => i === 0 || n > seen[i - 1])).toBe(true);
  });

  it('rejects a solution presented from a DIFFERENT IP than the challenge was issued to', async () => {
    const solution = await solveRegistrationPow(issueRegistrationChallenge(IP, 0));
    await expect(verifyRegistrationPow('198.51.100.1', solution)).rejects.toThrow('invalid or expired');
  });

  it('rejects tampered fields — difficulty cannot be lowered after issuance', async () => {
    const challenge = issueRegistrationChallenge(IP, 5);
    const downgraded = { ...challenge, difficulty: 1 };
    const solution = await solveRegistrationPow(downgraded);
    await expect(verifyRegistrationPow(IP, solution)).rejects.toThrow('invalid or expired');
  });

  it('rejects a wrong nonce even with a valid signature', async () => {
    const challenge = issueRegistrationChallenge(IP, 0);
    // Find a nonce that does NOT satisfy even the dev difficulty
    let badNonce = '0';
    for (let n = 0; n < 10_000; n++) {
      const sol = { ...challenge, nonce: String(n) };
      try {
        // difficulty in dev is small, so most nonces fail; grab the first failure
        await verifyRegistrationPow(IP, sol);
      } catch {
        badNonce = String(n);
        break;
      }
    }
    await expect(verifyRegistrationPow(IP, { ...challenge, nonce: badNonce })).rejects.toThrow('invalid or expired');
  });

  it('rejects expired challenges', async () => {
    const challenge = issueRegistrationChallenge(IP, 0);
    const solution = await solveRegistrationPow(challenge);
    const expired = { ...solution, expires: Date.now() - 1000 };
    await expect(verifyRegistrationPow(IP, expired)).rejects.toThrow('invalid or expired');
  });

  it('burns each challenge — a replayed solution is refused', async () => {
    const solution = await solveRegistrationPow(issueRegistrationChallenge(IP, 0));
    await verifyRegistrationPow(IP, solution);

    redisSet.mockResolvedValueOnce(null); // NX failed — already redeemed
    await expect(verifyRegistrationPow(IP, solution)).rejects.toThrow('invalid or expired');
  });

  it('single-use FAILS OPEN on Redis errors — HMAC and expiry still hold', async () => {
    const solution = await solveRegistrationPow(issueRegistrationChallenge(IP, 0));
    redisSet.mockRejectedValueOnce(new Error('redis down'));
    await expect(verifyRegistrationPow(IP, solution)).resolves.toBeUndefined();
  });

  it('rejects structural garbage without touching Redis', async () => {
    for (const junk of [undefined, null, 42, 'pow', {}, { challenge: 'short' }]) {
      await expect(verifyRegistrationPow(IP, junk)).rejects.toThrow('invalid or expired');
    }
    expect(redisSet).not.toHaveBeenCalled();
  });
});

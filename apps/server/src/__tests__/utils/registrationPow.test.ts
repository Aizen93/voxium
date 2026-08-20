import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisSet = vi.fn();
vi.mock('../../utils/redis', () => ({
  getRedis: () => ({ set: redisSet }),
}));

import { issueRegistrationChallenge, verifyRegistrationPow, baseDifficulty } from '../../utils/registrationPow';
import { solveRegistrationPow, POW_MAX_DIFFICULTY } from '@voxium/shared';

const IP = '203.0.113.9';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret-for-pow-hmac-derivation';
  redisSet.mockResolvedValue('OK'); // NX succeeded — first redemption
});

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

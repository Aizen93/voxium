// Server half of the registration proof-of-work (packages/shared/src/pow.ts
// documents the protocol and the privacy rationale).
//
// The HMAC key is DERIVED from JWT_SECRET rather than being a new env var:
// boot already refuses to start without JWT_SECRET, so the gate can never be
// silently unconfigured in production — the TOTP_ENCRYPTION_KEY lesson,
// solved by construction instead of another fail-closed check.
import crypto from 'crypto';
import { BadRequestError } from './errors';
import { getRedis } from './redis';
import {
  POW_MAX_DIFFICULTY,
  POW_CHALLENGE_TTL_MS,
  leadingZeroBits,
  type PowChallenge,
  type PowSolution,
} from '@voxium/shared';

/** Base difficulty: ~65k hashes, a second or two of browser WebCrypto. Free
 *  for a human registering once; real money at bot scale. Dev/test issue a
 *  trivial target so suites exercise the full path in microseconds. */
const BASE_DIFFICULTY_PROD = 16;
const BASE_DIFFICULTY_DEV = 4;
/** Added bits per registration the caller's /24 (or /48) already made today —
 *  each +2 QUADRUPLES the work. A subnet at its 5th signup of the day pays
 *  ~256x the base; the NAT-friendly alternative to hard-refusing. */
const PRESSURE_STEP_BITS = 2;

function powSecret(): Buffer {
  return crypto.createHash('sha256').update(`voxium-register-pow:${process.env.JWT_SECRET!}`).digest();
}

function signChallenge(challenge: string, difficulty: number, expires: number, ip: string): string {
  return crypto.createHmac('sha256', powSecret())
    .update(`${challenge}|${difficulty}|${expires}|${ip}`)
    .digest('hex');
}

export function baseDifficulty(): number {
  return process.env.NODE_ENV === 'production' ? BASE_DIFFICULTY_PROD : BASE_DIFFICULTY_DEV;
}

/**
 * Mint a challenge for this caller. Difficulty is decided HERE, at issuance,
 * and sealed into the signature — redemption never recomputes it, so a
 * legitimate solve can't be invalidated by someone else registering from the
 * same subnet mid-solve.
 */
export function issueRegistrationChallenge(ip: string, subnetRegistrationsToday: number): PowChallenge {
  const difficulty = Math.min(
    baseDifficulty() + PRESSURE_STEP_BITS * Math.max(0, subnetRegistrationsToday),
    POW_MAX_DIFFICULTY,
  );
  const challenge = crypto.randomBytes(16).toString('hex');
  const expires = Date.now() + POW_CHALLENGE_TTL_MS;
  return { challenge, difficulty, expires, sig: signChallenge(challenge, difficulty, expires, ip) };
}

/**
 * Verify a solution and burn the challenge. Throws BadRequestError with one
 * deliberately uniform message — which check failed is not the client's
 * business. Single-use enforcement fails OPEN on Redis errors (matching the
 * rate limiters): the HMAC + expiry still hold, and availability of
 * registration beats replay-hardening a 5-minute window.
 */
export async function verifyRegistrationPow(ip: string, pow: unknown): Promise<void> {
  const fail = () => new BadRequestError('Registration challenge is invalid or expired — refresh and try again');

  if (!pow || typeof pow !== 'object') throw fail();
  const p = pow as Partial<PowSolution>;
  if (
    typeof p.challenge !== 'string' || p.challenge.length !== 32 ||
    typeof p.nonce !== 'string' || p.nonce.length > 20 ||
    typeof p.difficulty !== 'number' || !Number.isInteger(p.difficulty) ||
    p.difficulty < 1 || p.difficulty > POW_MAX_DIFFICULTY ||
    typeof p.expires !== 'number' || typeof p.sig !== 'string' || p.sig.length !== 64
  ) throw fail();

  if (p.expires < Date.now()) throw fail();

  const expected = signChallenge(p.challenge, p.difficulty, p.expires, ip);
  const sigBuf = Buffer.from(p.sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) throw fail();

  const digest = crypto.createHash('sha256').update(`${p.challenge}.${p.nonce}`).digest();
  if (leadingZeroBits(digest) < p.difficulty) throw fail();

  // Decide-outside-the-try so the replay rejection can never be swallowed by
  // the fail-open path (a thrown rejection inside would look like a Redis
  // error to our own catch).
  let burned: string | null = 'OK';
  try {
    const ttlSeconds = Math.ceil((p.expires - Date.now()) / 1000) + 60;
    burned = await getRedis().set(`pow:used:${p.challenge}`, '1', { NX: true, EX: ttlSeconds });
  } catch (err) {
    console.warn('[Auth] PoW single-use check failed (allowing — HMAC and expiry still verified):', err);
  }
  if (burned === null) throw fail(); // already redeemed — a replay
}

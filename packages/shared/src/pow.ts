// Self-hosted proof-of-work for the registration endpoint (anti-bot Phase 3).
//
// Why PoW and not a captcha: reCAPTCHA/hCaptcha/Turnstile are third-party
// services — every visitor would be reported to someone else's server, which
// the privacy rules forbid. PoW is invisible to users, fully self-contained,
// and — because the SERVER enforces it — costs direct-API bots the same CPU
// as browser bots. Cadence tricks and IP rotation don't help: every single
// registration pays.
//
// Protocol:
//  1. GET /auth/register-challenge → { challenge, difficulty, expires, sig }
//     (HMAC-signed by the server; difficulty adapts to recent registration
//     pressure from the caller's subnet)
//  2. Client finds a nonce where sha256(`${challenge}.${nonce}`) has at least
//     `difficulty` leading zero BITS, and submits { ...challenge fields, nonce }
//     with the registration.
//  3. Server re-verifies the HMAC, the expiry, the hash target, and burns the
//     challenge in Redis (single use).
//
// This module is environment-agnostic: WebCrypto (`globalThis.crypto.subtle`)
// exists in browsers, workers, and Node ≥18 — the desktop app, the Playwright
// helpers and the load scripts all use this same solver.

export interface PowChallenge {
  /** Random hex nonce minted by the server. */
  challenge: string;
  /** Required leading zero BITS of sha256(`${challenge}.${nonce}`). */
  difficulty: number;
  /** Unix ms expiry — solves are worthless after this. */
  expires: number;
  /** Server HMAC over challenge|difficulty|expires|ip. Opaque to clients. */
  sig: string;
}

export interface PowSolution extends PowChallenge {
  nonce: string;
}

/** Sanity ceiling — a signed difficulty above this is rejected outright
 *  (a tampered/foreign signature would already fail the HMAC, this is
 *  defense-in-depth against ever asking a browser for an unsolvable puzzle).
 *
 *  WHY 20 AND NOT HIGHER. Solve time is geometric in the number of tries, so
 *  the MEAN is not the number that matters — the tail is. Measured WebCrypto
 *  throughput is ~60k digests/s on a fast desktop and roughly a tenth of that
 *  on a low-end phone. At 24 bits (16.8M expected digests) a third of solves
 *  blew the old 5-minute window on Node speed alone and most did on a phone:
 *  the ceiling was a registration outage for anyone sharing a busy /24. At 20
 *  bits (1.05M expected) the phone case averages ~105s against the 15-minute
 *  window below, i.e. a tail failure rate around 0.02%.
 *
 *  If you ever raise this, raise POW_CHALLENGE_TTL_MS with it — the guard test
 *  in registrationPow.test.ts pins the relationship. */
export const POW_MAX_DIFFICULTY = 20;

/** Challenge lifetime. Sized so the SLOWEST plausible device still solves the
 *  HARDEST issuable challenge inside it with room to spare (see the ceiling
 *  note above), then finishes typing. A longer window costs nothing
 *  security-wise: the challenge is random, single-use, HMAC-bound to the
 *  caller's IP and burned in Redis on redemption, so hoarding cheap challenges
 *  buys an attacker no work reduction — every registration still pays. */
export const POW_CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** Expected number of digests to clear `difficulty` leading zero bits. The
 *  distribution is geometric, so this is a mean, not a bound — a solve can
 *  legitimately take several times this. Used for progress reporting. */
export function powExpectedAttempts(difficulty: number): number {
  return 2 ** difficulty;
}

export interface PowSolveOptions {
  /** Called every `batchSize` attempts with the running attempt count. */
  onProgress?: (attempts: number, expected: number) => void;
  /** Attempts between progress callbacks. Ignored without `onProgress`. */
  batchSize?: number;
  /** Abort an in-flight solve. Checked at the same cadence as the deadline, so
   *  a caller that walks away (the register view unmounting, say) stops paying
   *  for a solution nobody is waiting for — on the in-thread path this loop is
   *  the main thread. */
  signal?: AbortSignal;
}

/** Thrown when the challenge's own deadline passes mid-solve — the solution
 *  would be rejected by `verifyRegistrationPow` anyway, so grinding on is pure
 *  waste. Callers should fetch a fresh challenge and retry. */
export class PowAbortedError extends Error {
  constructor() {
    super('Registration proof-of-work was aborted');
    this.name = 'PowAbortedError';
  }
}

export class PowExpiredError extends Error {
  constructor() {
    super('Registration challenge expired before it was solved');
    this.name = 'PowExpiredError';
  }
}

/** Attempts between deadline checks. Coarse on purpose: one Date.now() per
 *  nonce would cost more than the hash on a fast machine. */
const DEADLINE_CHECK_EVERY = 4096;

/** Count leading zero bits of a hash. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) { bits += 8; continue; }
    let b = byte;
    while ((b & 0x80) === 0) { bits += 1; b <<= 1; }
    break;
  }
  return bits;
}

/**
 * Solve a registration challenge. Difficulty 16 ≈ 65k hashes (a second or two
 * of WebCrypto); dev/test environments issue tiny difficulties so suites pay
 * microseconds, through the exact same code path as production.
 *
 * Stays a plain async function on purpose — the desktop app runs it inside a
 * Web Worker (see apps/desktop/src/services/powSolver.ts) while the Playwright
 * helpers and the load scripts call it directly under Node. A worker-only
 * rewrite would break those and the environment-agnostic contract at the top
 * of this file.
 */
export async function solveRegistrationPow(
  challenge: PowChallenge,
  options?: PowSolveOptions,
): Promise<PowSolution> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable — cannot solve registration challenge');
  const encoder = new TextEncoder();
  const expected = powExpectedAttempts(challenge.difficulty);
  const batchSize = Math.max(1, options?.batchSize ?? 2048);
  // The deadline is ELAPSED LOCAL TIME and nothing else — not the difference
  // between a server timestamp and a client clock, in either direction.
  //
  // Deriving the budget from `expires` looks harmless because the CHECK below
  // is still local, but it smuggles the server's clock back in: a device 12
  // minutes fast computes `expires - now` as three minutes and gives up on a
  // solve the server would have accepted, then refetches and gives up again.
  // It is not even monotonic — skew past the whole TTL makes the difference
  // negative and hands back the FULL budget, so a mildly wrong clock is
  // punished harder than a wildly wrong one. Network and page-load latency come
  // out of the same allowance.
  //
  // Overrunning costs only local CPU: the server rejects a genuinely stale
  // solve on its own clock, which is the only clock entitled to that call.
  const startedAt = Date.now();
  const budgetMs = POW_CHALLENGE_TTL_MS;
  for (let nonce = 0; ; nonce++) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(`${challenge.challenge}.${nonce}`)));
    if (leadingZeroBits(digest) >= challenge.difficulty) {
      return { ...challenge, nonce: String(nonce) };
    }
    if (nonce > 0 && nonce % DEADLINE_CHECK_EVERY === 0) {
      // Nobody is waiting for this any more — stop burning the thread.
      if (options?.signal?.aborted) throw new PowAbortedError();
      // Bail once the window has elapsed instead of grinding for minutes on a
      // solution the server will reject — the caller can refetch and restart.
      if (Date.now() - startedAt >= budgetMs) throw new PowExpiredError();
    }
    if (options?.onProgress && nonce > 0 && nonce % batchSize === 0) {
      options.onProgress(nonce, expected);
    }
  }
}

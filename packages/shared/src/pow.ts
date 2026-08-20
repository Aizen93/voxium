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
 *  defense-in-depth against ever asking a browser for an unsolvable puzzle). */
export const POW_MAX_DIFFICULTY = 24;

/** Challenge lifetime. Long enough for a slow device to solve and the user
 *  to finish typing; short enough that hoarding cheap challenges is useless. */
export const POW_CHALLENGE_TTL_MS = 5 * 60 * 1000;

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
 */
export async function solveRegistrationPow(challenge: PowChallenge): Promise<PowSolution> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable — cannot solve registration challenge');
  const encoder = new TextEncoder();
  for (let nonce = 0; ; nonce++) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(`${challenge.challenge}.${nonce}`)));
    if (leadingZeroBits(digest) >= challenge.difficulty) {
      return { ...challenge, nonce: String(nonce) };
    }
  }
}

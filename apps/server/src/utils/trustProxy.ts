/**
 * Does this deployment sit behind a trusted reverse proxy?
 *
 * ONE answer for the whole process: Express's `trust proxy` (app.ts) and the
 * socket handshake's X-Forwarded-For parse (socketServer.ts) both key IpBan
 * lookups and IpRecord attribution on "the caller's address", and two
 * controls that disagree about an address fail open. Gating the socket side
 * on NODE_ENV alone left a `TRUST_PROXY=true` staging deploy — the documented
 * knob for "behind nginx" — with REST bans keyed on real client IPs and socket
 * bans keyed on nginx's address: unenforceable on the one surface that can
 * evict an already-authenticated session.
 *
 * Read lazily, never at module scope: dotenv runs after imports are hoisted.
 */
export function trustsProxy(): boolean {
  return process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production';
}

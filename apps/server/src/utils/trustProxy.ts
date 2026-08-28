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

export const DEFAULT_TRUSTED_PROXY_HOPS = 1;
export const MAX_TRUSTED_PROXY_HOPS = 10;

let hopsCache: { raw: string | undefined; hops: number } | null = null;

/**
 * How many reverse-proxy hops sit between the internet and this process —
 * `TRUST_PROXY_HOPS`, default 1 (one nginx).
 *
 * This number is what makes the per-IP and per-subnet abuse controls mean
 * anything: Express's `trust proxy` and the socket handshake's
 * X-Forwarded-For parse both take the N-th address from the RIGHT of the
 * chain as the caller. Put an OVH Load Balancer in front of nginx without
 * raising it to 2 and every user on the internet collapses into one bucket
 * keyed on nginx's address; raise it to 2 WITHOUT the second proxy and any
 * client can pick its own address by sending an X-Forwarded-For header.
 * Change the topology and this value together, never one without the other.
 *
 * Only meaningful when trustsProxy() is true. Invalid values fall back to 1
 * with a warning (once per distinct value — this is read per connection).
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (hopsCache && hopsCache.raw === raw) return hopsCache.hops;
  let hops = DEFAULT_TRUSTED_PROXY_HOPS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_TRUSTED_PROXY_HOPS) {
      hops = n;
    } else {
      console.warn(`[TrustProxy] Ignoring TRUST_PROXY_HOPS=${JSON.stringify(raw)} (want an integer 1-${MAX_TRUSTED_PROXY_HOPS}); using ${DEFAULT_TRUSTED_PROXY_HOPS}`);
    }
  }
  hopsCache = { raw, hops };
  return hops;
}

/**
 * The caller's address from an X-Forwarded-For chain, by the same rule
 * Express applies for `trust proxy: N` (proxy-addr): walk from the right,
 * skipping N trusted proxies (the socket peer is the first of them), and
 * take the first untrusted entry — or the leftmost one if the chain is
 * shorter than N. Returns undefined for an empty chain.
 */
export function forwardedClientAddress(chain: string, hops: number = trustedProxyHops()): string | undefined {
  const entries = chain.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
  if (entries.length === 0) return undefined;
  return entries[Math.max(0, entries.length - hops)];
}

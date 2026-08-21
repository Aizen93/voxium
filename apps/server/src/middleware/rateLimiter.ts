import net from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getRedis, getRedisPubSub, getRedisConfigSub } from '../utils/redis';

// ─── Rate limit configuration registry ──────────────────────────────────────

export interface RateLimitConfig {
  points: number;
  duration: number;
  blockDuration: number;
}

interface RateLimitDef extends RateLimitConfig {
  keyPrefix: string;
  keyType: 'ip' | 'userId';
  label: string;
}

const DEFAULTS: Record<string, RateLimitDef> = {
  login:          { keyPrefix: 'rl:login',    points: 5,   duration: 60,  blockDuration: 300, keyType: 'ip',     label: 'Login' },
  register:       { keyPrefix: 'rl:register', points: 3,   duration: 60,  blockDuration: 600, keyType: 'ip',     label: 'Register' },
  // Long-window registration counters: the short window above misses slow
  // drips entirely (one signup every 45 minutes is 32/day and never trips
  // 3/min). Per-IP catches a patient single address; per-/24 catches rotation
  // inside a range. Sized so no household hits them and a shared office NAT
  // barely can (5 signups from one machine in a DAY is not organic).
  //
  // Charged atomically by `chargeRegistrationBudgets` and REFUNDED unless the
  // request actually created an account — see that function for why a read-then-
  // consume-later split loses the bound entirely. As plain consuming middleware
  // they charged every 400: a user who hit taken-username → taken-email →
  // expired challenge burned 3 of 5 daily points, and 20 throwaway POSTs from
  // any address in a target org's /24 locked that whole range out for a day.
  // The cheap attempt buckets below are what bound garbage instead — one per
  // address, one per range, neither ever refunded.
  registerDaily:  { keyPrefix: 'rl:regday',   points: 5,   duration: 86400, blockDuration: 0, keyType: 'ip',     label: 'Register (daily per IP)' },
  registerSubnet: { keyPrefix: 'rl:regnet',   points: 20,  duration: 86400, blockDuration: 0, keyType: 'ip',     label: 'Register (daily per subnet)' },
  // Attempts — successful or not — per IP per day. This is the bucket that
  // bounds username/email enumeration now that the two above only count
  // successes. Deliberately cheap and generous: a fumbling real user has
  // plenty of headroom, while a prober gets 30 probes a day per address.
  registerAttempt:{ keyPrefix: 'rl:regatt',   points: 30,  duration: 86400, blockDuration: 0, keyType: 'ip',     label: 'Register (daily attempts per IP)' },
  // The same bound, per RANGE — and the one that actually holds. Per-address is
  // no bound at all against an attacker who has a /24, or any routed IPv6 /64:
  // 254 x 30 is 7,620 confirmed probes a day, and v6 rotation is free. Since a
  // 409 on a random username means the EMAIL exists, registration is an
  // account-existence oracle, and before the daily budgets started refunding
  // failures it was capped at 20 probes per /24 per day.
  //
  // 300 rather than 20: this must never re-create the availability bug the
  // refund fixed. A NAT'd office shares one or two addresses, so `registerAttempt`
  // binds there long before this does, and 300 signup ATTEMPTS a day out of one
  // /24 or /48 is already far past organic. It is a `rl:` bucket like the rest,
  // so the admin rate-limit API can raise it for a genuinely large shared range
  // without a deploy.
  registerAttemptSubnet:
                  { keyPrefix: 'rl:regattnet', points: 300, duration: 86400, blockDuration: 0, keyType: 'ip',    label: 'Register (daily attempts per subnet)' },
  // Challenge minting is stateless (HMAC) so it is cheap to serve, but a
  // limit keeps a hostile client from turning the endpoint into a hash-mint
  // treadmill. Generous: a legit flow needs exactly one per registration.
  powChallenge:   { keyPrefix: 'rl:powchal',  points: 30,  duration: 60,  blockDuration: 0,   keyType: 'ip',     label: 'Registration Challenge' },
  // Novel-domain budget: keyed by EMAIL DOMAIN (major consumer providers are
  // exempt in the service). NOT used as route middleware — consumed only
  // after a successful create (authService), so garbage attempts cannot burn
  // a legitimate small-org domain's budget and lock its employees out.
  registerDomain: { keyPrefix: 'rl:regdom',   points: 10,  duration: 86400, blockDuration: 0, keyType: 'ip',     label: 'Register (daily per email domain)' },
  // Per-INBOX daily mail caps, keyed on the CANONICAL address. The per-IP and
  // per-user limiters bound the burst rate; these bound how much mail one real
  // mailbox can be made to receive in a day no matter which account, address
  // spelling, IP or cadence asks — we must never become a drip harasser of
  // whoever really owns an address. blockDuration MUST stay 0: a block would
  // push the window past 24h. Consumed via `consumeMailCap`, not middleware —
  // the key is an email, not a request property.
  verifyMail:     { keyPrefix: 'rl:vfymail',  points: 5,   duration: 86400, blockDuration: 0, keyType: 'ip',     label: 'Verification mail (daily per inbox)' },
  resetMail:      { keyPrefix: 'rl:rstmail',  points: 5,   duration: 86400, blockDuration: 0, keyType: 'ip',     label: 'Password-reset mail (daily per inbox)' },
  forgotPassword: { keyPrefix: 'rl:forgot',   points: 3,   duration: 900, blockDuration: 0,   keyType: 'ip',     label: 'Forgot Password' },
  resetPassword:  { keyPrefix: 'rl:reset',    points: 5,   duration: 900, blockDuration: 0,   keyType: 'ip',     label: 'Reset Password' },
  refresh:        { keyPrefix: 'rl:refresh',  points: 10,  duration: 60,  blockDuration: 0,   keyType: 'ip',     label: 'Token Refresh' },
  changePassword: { keyPrefix: 'rl:chgpwd',   points: 5,   duration: 60,  blockDuration: 300, keyType: 'ip',     label: 'Change Password' },
  totp:           { keyPrefix: 'rl:totp',     points: 10,  duration: 60,  blockDuration: 300, keyType: 'userId', label: 'TOTP Management' },
  messageSend:    { keyPrefix: 'rl:msg',       points: 30,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Message Send' },
  upload:         { keyPrefix: 'rl:upload',    points: 10,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Upload' },
  friendRequest:  { keyPrefix: 'rl:friend',    points: 20,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Friend Request' },
  memberManage:   { keyPrefix: 'rl:member',    points: 20,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Member Manage' },
  categoryManage: { keyPrefix: 'rl:category',  points: 20,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Category Manage' },
  search:         { keyPrefix: 'rl:search',    points: 15,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Search' },
  stats:          { keyPrefix: 'rl:stats',     points: 30,  duration: 60,  blockDuration: 0,   keyType: 'ip',     label: 'Stats' },
  admin:          { keyPrefix: 'rl:admin',     points: 60,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Admin' },
  report:         { keyPrefix: 'rl:report',    points: 5,   duration: 300, blockDuration: 0,   keyType: 'userId', label: 'Report' },
  support:        { keyPrefix: 'rl:support',   points: 10,  duration: 30,  blockDuration: 0,   keyType: 'userId', label: 'Support' },
  verifyEmail:        { keyPrefix: 'rl:vfyeml', points: 5, duration: 900, blockDuration: 300, keyType: 'ip',     label: 'Verify Email' },
  resendVerification: { keyPrefix: 'rl:verify', points: 3, duration: 300, blockDuration: 300, keyType: 'userId', label: 'Resend Verification' },
  markRead:       { keyPrefix: 'rl:markread',  points: 60,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Mark Read' },
  roleManage:     { keyPrefix: 'rl:role',      points: 20,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Role Manage' },
  // Secure-channel create/rename/delete. Deliberately tight: every create can
  // fan out key shares from all members' clients, so churn is expensive.
  secureChannelManage: { keyPrefix: 'rl:secchan', points: 10, duration: 300, blockDuration: 0, keyType: 'userId', label: 'Secure Channel Manage' },
  general:        { keyPrefix: 'rl:general',   points: 100, duration: 60,  blockDuration: 0,   keyType: 'ip',     label: 'General' },
  interact:       { keyPrefix: 'rl:interact',  points: 60,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Message Interact' },
  themeManage:    { keyPrefix: 'rl:theme',     points: 20,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Theme Manage' },
  themeBrowse:    { keyPrefix: 'rl:themebr',   points: 30,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Theme Browse' },
  // E2E key distribution: registration is rare (per install / key reset);
  // bundle claims consume the TARGET user's one-time keys, so they get a
  // tighter budget than plain reads to slow deliberate prekey draining.
  e2eDevice:      { keyPrefix: 'rl:e2edev',    points: 5,   duration: 3600, blockDuration: 0,  keyType: 'userId', label: 'E2E Device Register' },
  e2eKeys:        { keyPrefix: 'rl:e2ekeys',   points: 10,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'E2E Key Upload' },
  // Sized for the worst LEGITIMATE burst: a secure channel's first rotation
  // claims one bundle per member device it has no Olm session with —
  // SECURE_CHANNEL_MEMBER_CAP (25) x MAX_DEVICES (5) ≈ 125 — plus DM headroom.
  // The old 15/min starved first rotations at the advertised cap, permanently
  // (retry budget exhausted before the tail devices ever got a key). Bundle
  // claims remain gated by assertSharesE2EContext, and the fallback key means
  // OTK depletion is never a hard DoS (spec §4.3), so the anti-harvest role of
  // this limiter tolerates the larger budget.
  e2eBundle:      { keyPrefix: 'rl:e2ebundle', points: 150, duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'E2E Bundle Claim' },
  // Device-list reads sit on the message send path (every encrypted send
  // re-checks the peer's devices before rotating), so this budget has to cover
  // a fast typist, not just UI refreshes.
  e2eStatus:      { keyPrefix: 'rl:e2estat',   points: 300, duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'E2E Device Status' },
  // Group-session key fan-out: one batched POST per rotation plus periodic
  // claims, so a modest budget covers normal multi-device use.
  e2eShares:      { keyPrefix: 'rl:e2eshare',  points: 30,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'E2E Key Shares' },
  // Cross-signing writes must NOT share the 5/hour device-registration
  // bucket: setting up several devices costs a publish plus one approval
  // each, and a 429 mid-approval leaves a device half-approved.
  e2eApprove:     { keyPrefix: 'rl:e2eappr',   points: 30,  duration: 3600, blockDuration: 0,  keyType: 'userId', label: 'E2E Approval' },
};

// Overrides loaded from Redis on init, updated via admin API
const overrides: Record<string, Partial<RateLimitConfig>> = {};

// Cached limiter instances — nulled on config change to force recreation
const limiters: Record<string, RateLimiterRedis | null> = {};

function getConfig(name: string): RateLimitDef {
  const def = DEFAULTS[name];
  if (!def) throw new Error(`Unknown rate limiter: ${name}`);
  const ovr = overrides[name];
  if (!ovr) return def;
  return { ...def, ...ovr };
}

function getLimiter(name: string): RateLimiterRedis {
  if (!limiters[name]) {
    const cfg = getConfig(name);
    const insuranceLimiter = new RateLimiterMemory({
      points: cfg.points,
      duration: cfg.duration,
      blockDuration: cfg.blockDuration,
    });
    limiters[name] = new RateLimiterRedis({
      storeClient: getRedis(),
      useRedisPackage: true,
      keyPrefix: cfg.keyPrefix,
      points: cfg.points,
      duration: cfg.duration,
      blockDuration: cfg.blockDuration,
      insuranceLimiter,
    });
  }
  return limiters[name]!;
}

// ─── Admin API helpers ───────────────────────────────────────────────────────

const REDIS_CONFIG_KEY = 'rl:config';
const RL_CONFIG_CHANNEL = 'config:rate_limits';

/** Load overrides from Redis on server startup */
export async function loadRateLimitOverrides(): Promise<void> {
  try {
    const redis = getRedis();
    const data = await redis.hGetAll(REDIS_CONFIG_KEY);
    for (const [name, json] of Object.entries(data)) {
      if (DEFAULTS[name]) {
        overrides[name] = JSON.parse(json);
        limiters[name] = null; // force recreation
      }
    }
  } catch {
    console.error('[RateLimit] Failed to load overrides from Redis, using defaults');
  }

  // Subscribe to config changes from other nodes
  try {
    const configSub = getRedisConfigSub();
    await configSub.subscribe(RL_CONFIG_CHANNEL, (message) => {
      try {
        const { name, config, action } = JSON.parse(message);
        if (!DEFAULTS[name]) return;
        if (action === 'reset') {
          delete overrides[name];
        } else {
          overrides[name] = config;
        }
        limiters[name] = null; // force recreation
      } catch { /* ignore malformed messages */ }
    });
  } catch (err) {
    console.error('[RateLimit] Failed to subscribe to config channel:', err);
  }
}

/** Get all rate limit rules (defaults merged with overrides) */
export function getAllRateLimits(): Array<RateLimitDef & { name: string; isCustom: boolean }> {
  return Object.entries(DEFAULTS).map(([name, _def]) => ({
    name,
    ...getConfig(name),
    isCustom: !!overrides[name],
  }));
}

/** Update a specific rate limit rule and notify all nodes. */
export async function updateRateLimit(name: string, updates: Partial<RateLimitConfig>): Promise<void> {
  if (!DEFAULTS[name]) throw new Error(`Unknown rate limiter: ${name}`);
  const clean: Partial<RateLimitConfig> = {};
  if (updates.points !== undefined) clean.points = Math.max(1, Math.floor(updates.points));
  if (updates.duration !== undefined) clean.duration = Math.max(1, Math.floor(updates.duration));
  if (updates.blockDuration !== undefined) clean.blockDuration = Math.max(0, Math.floor(updates.blockDuration));
  overrides[name] = { ...overrides[name], ...clean };
  limiters[name] = null; // force recreation with new config
  await getRedis().hSet(REDIS_CONFIG_KEY, name, JSON.stringify(overrides[name]));
  const { pub } = getRedisPubSub();
  await pub.publish(RL_CONFIG_CHANNEL, JSON.stringify({ name, config: overrides[name], action: 'set' }));
}

/** Reset a rate limit rule to its default and notify all nodes. */
export async function resetRateLimit(name: string): Promise<void> {
  if (!DEFAULTS[name]) throw new Error(`Unknown rate limiter: ${name}`);
  delete overrides[name];
  limiters[name] = null;
  await getRedis().hDel(REDIS_CONFIG_KEY, name);
  const { pub } = getRedisPubSub();
  await pub.publish(RL_CONFIG_CHANNEL, JSON.stringify({ name, action: 'reset' }));
}

/** Delete all rate limit keys for a specific user or IP */
export async function clearUserRateLimits(key: string): Promise<number> {
  const redis = getRedis();
  const prefixes = Object.values(DEFAULTS).map((d) => d.keyPrefix);
  let cleared = 0;
  for (const prefix of prefixes) {
    const redisKey = `${prefix}:${key}`;
    const result = await redis.del(redisKey);
    cleared += result;
  }
  return cleared;
}

// ─── Middleware factories ────────────────────────────────────────────────────

function createMiddleware(
  name: string,
  keyFn: (req: Request) => string,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await getLimiter(name).consume(keyFn(req));
      next();
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(err.msBeforeNext / 1000);
        res.set('Retry-After', String(retryAfter));
        res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
        return;
      }
      // Redis error or unexpected — fail open but log for visibility
      console.warn(`[RateLimit] ${name} limiter error, allowing request:`, err instanceof Error ? err.message : err);
      next();
    }
  };
}

/**
 * ONE canonical form for an address, used by every key that must agree about
 * "the same caller": rate-limit buckets, subnet grouping, IpBan matching, the
 * PoW HMAC binding, and IpRecord attribution.
 *
 * Handles what the old inline `startsWith('::ffff:')` strip did not:
 *  - zone ids (`fe80::1%eth0`) — a per-interface suffix that would key a
 *    link-local address per NIC;
 *  - the IPv4-mapped form in UPPERCASE (`::FFFF:1.2.3.4`) and in hex
 *    (`::ffff:cb00:7107`), both of which slipped through as IPv6 and
 *    collapsed every such client into one shared bucket;
 *  - hex case, so `2001:DB8::1` and `2001:db8::1` are one caller.
 */
export function normalizeIp(rawIp: string): string {
  // Strip a zone id ONLY when what is left is a real address — otherwise a
  // stray '%' in garbage input would silently truncate the passthrough value.
  const zoneless = rawIp.split('%')[0];
  const ip = net.isIP(zoneless) ? zoneless : rawIp;
  if (net.isIPv4(ip)) return ip;
  const hextets = ipv6Hextets(ip);
  if (!hextets) return ip; // not an address at all — pass through untouched
  const mapped = mappedIPv4(hextets);
  return mapped ?? ip.toLowerCase();
}

const byIp = (req: Request) => normalizeIp(req.ip || req.socket.remoteAddress || 'unknown');
const byUserId = (req: Request) => req.user?.userId || req.ip || 'unknown';

/**
 * Charge the daily registration budgets, then REFUND them unless the request
 * actually created an account.
 *
 * Why not simply read them here and consume after the create: a read is not a
 * reservation. Between the check and the charge sits the whole handler —
 * a PoW verify, an IpBan lookup, a uniqueness query and a bcrypt(12) — so a
 * concurrent burst all reads the same pre-burst count and all passes. Measured:
 * 200 simultaneous requests against a cap of 20 admitted all 200; issued
 * serially the same requests admitted exactly 20. The per-/48 bucket is the
 * only control that survives IPv6 address rotation, so losing its atomicity
 * loses the bound entirely.
 *
 * Consume-then-refund keeps the atomic INCR and still gives failed attempts
 * back their points, which is what the fix was actually for: as plain
 * consuming middleware, a user who hit taken-username → taken-email → expired
 * challenge burned 3 of 5 daily points, and 20 garbage POSTs from any address
 * in a target org's /24 locked that whole range out of signup for a day.
 * Enumeration stays bounded by `registerAttempt`, which is never refunded.
 */
export const chargeRegistrationBudgets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const charged: Array<{ name: string; key: string }> = [];
  let rejection: RateLimiterRes | null = null;

  for (const [name, key] of [['registerDaily', byIp(req)], ['registerSubnet', bySubnet(req)]] as const) {
    if (rejection) break;
    try {
      await getLimiter(name).consume(key);
      charged.push({ name, key });
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        rejection = err;
        // A rejected consume still INCREMENTED — refund it too, or a refused
        // attempt would push the bucket permanently past its cap and keep
        // inflating the subnet's PoW difficulty for everyone behind it.
        charged.push({ name, key });
      // Redis error or unexpected — fail open but log for visibility
      } else console.warn(`[RateLimit] ${name} limiter error, allowing request:`, err instanceof Error ? err.message : err);
    }
  }

  if (rejection) {
    // Everything taken, back out: the caller is not registering today, so it
    // must cost them nothing on either bucket.
    await Promise.all(charged.map((c) => refund(c.name, c.key)));
    res.set('Retry-After', String(Math.ceil(rejection.msBeforeNext / 1000)));
    res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    return;
  }

  // 'finish' fires for every terminal outcome, including errors turned into a
  // response by the error middleware. A client that aborts mid-request emits
  // 'close' without 'finish' and keeps the charge — erring toward charging is
  // the safe direction for an abuse counter.
  res.on('finish', () => {
    const created = res.statusCode >= 200 && res.statusCode < 300;
    if (created) return;
    void Promise.all(charged.map((c) => refund(c.name, c.key)));
  });
  next();
};

async function refund(name: string, key: string): Promise<void> {
  try {
    await getLimiter(name).reward(key);
  } catch (err) {
    // An unrefunded point costs one signup from that address today — noisy for
    // the user, never a security failure, so it is only worth logging.
    console.warn(`[RateLimit] ${name} refund failed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Expand an IPv6 literal to its 8 hextets, or null if it is not one.
 *
 * The old implementation was `ip.split(':').slice(0, 3)`, which reads the
 * COMPRESSED text rather than the address: `2001:db8::a` splits to
 * ['2001','db8','','a'], so the third hextet was lost and the address keyed
 * `2001:db8:::/48` while its /48 neighbour `2001:db8:0:1::a` keyed
 * `2001:db8:0::/48`. Worse, with hextets 2 AND 3 both zero the key absorbed
 * the interface id and the /48 limiter degraded to per-address — unbounded,
 * not merely doubled.
 */
function ipv6Hextets(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let text = ip;
  // A trailing dotted quad occupies the last two hextets (::ffff:1.2.3.4)
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  let tail: number[] = [];
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = text.slice(0, dotted.index);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const [head, rest, extra] = text.split('::');
  if (extra !== undefined) return null; // more than one '::' is not an address
  const parse = (part: string) => (part ? part.split(':').map((h) => parseInt(h, 16)) : []);
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const filled = [...left, ...right, ...tail];
  if (rest === undefined) return filled.length === 8 ? filled : null;
  const gap = 8 - filled.length;
  if (gap < 0) return null;
  return [...left, ...Array(gap).fill(0), ...right, ...tail];
}

/** Dotted form when these hextets are an IPv4-mapped address, else null. */
function mappedIPv4(h: number[]): string | null {
  if (h[0] || h[1] || h[2] || h[3] || h[4] || h[5] !== 0xffff) return null;
  return `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
}

/**
 * Collapse an address to its network for range-rotation detection: /24 for
 * IPv4 (a home or small hosting range), /48 for IPv6 (the customer-site
 * allocation — /64s are handed out per-device, so grouping by /64 would see
 * every bot as a fresh network).
 *
 * Unparseable input passes through unchanged rather than being decorated with
 * a `/48` suffix — grouping strangers together is worse than not grouping.
 */
export function subnetOf(rawIp: string): string {
  const ip = normalizeIp(rawIp);
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  const hextets = ipv6Hextets(ip);
  if (!hextets) return ip;
  return `${hextets.slice(0, 3).map((h) => h.toString(16)).join(':')}::/48`;
}

const bySubnet = (req: Request) => subnetOf(req.ip || req.socket.remoteAddress || 'unknown');

/**
 * How many SUCCESSFUL registrations this caller's subnet has already made in
 * the current daily window — READ without consuming. Feeds the proof-of-work
 * difficulty: pressure raises the price instead of slamming the door (the
 * NAT-friendly posture). Fails soft to 0: no Redis, no extra difficulty.
 *
 * Successes only, since failed attempts are refunded. That is the point: they
 * used to escalate difficulty for every co-resident of the /24, so three
 * fumbles by one neighbour quadrupled the work for everyone behind the same
 * NAT. (A challenge minted in the brief window between a failing attempt's
 * charge and its refund still sees it — self-correcting, and erring toward
 * more work is the safe direction.) Enumeration is bounded by
 * `registerAttempt` / `registerAttemptSubnet` instead, which cost nobody any
 * CPU — and it takes BOTH: per-address alone is not a bound against anyone who
 * can rotate inside a /24 or a /48.
 */
export async function getSubnetRegistrationPressure(req: Request): Promise<number> {
  try {
    const res = await getLimiter('registerSubnet').get(bySubnet(req));
    return res?.consumedPoints ?? 0;
  } catch (err) {
    console.warn('[RateLimit] Subnet pressure read failed (assuming 0):', err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * Consume one point of a per-inbox mail cap. Returns false when over cap,
 * true otherwise — including when the store is unreachable, so a broken
 * counter can never lock users out of verification or password reset.
 *
 * A bucket rather than a bare Redis INCR because the `rl:` prefix is what the
 * e2e fixture clears between specs, what `clearUserRateLimits` can release for
 * a support case, and what the admin rate-limit API can raise during an
 * incident. Decision made OUTSIDE the try, per the house rule.
 */
export async function consumeMailCap(name: 'verifyMail' | 'resetMail', inbox: string): Promise<boolean> {
  let overCap = false;
  try {
    await getLimiter(name).consume(inbox);
  } catch (err) {
    if (err instanceof RateLimiterRes) overCap = true;
    else console.warn(`[RateLimit] ${name} cap check failed (allowing send):`, err instanceof Error ? err.message : err);
  }
  return !overCap;
}

/**
 * Novel-domain registration budget, split into READ (pre-create check) and
 * CONSUME (post-create count) so failed attempts never charge the domain —
 * see the `registerDomain` config note. A limiter bucket rather than a bare
 * Redis counter on purpose: the `rl:` prefix keeps it inside every existing
 * clearing path (test fixtures, admin resets), and the admin rate-limit API
 * can tune or raise it live like any other bucket.
 */
export async function getDomainRegistrationCount(domain: string): Promise<number> {
  try {
    const res = await getLimiter('registerDomain').get(domain);
    return res?.consumedPoints ?? 0;
  } catch (err) {
    console.warn('[RateLimit] Domain budget read failed (assuming 0):', err instanceof Error ? err.message : err);
    return 0;
  }
}

export async function countDomainRegistration(domain: string): Promise<void> {
  try {
    await getLimiter('registerDomain').consume(domain);
  } catch (err) {
    if (err instanceof RateLimiterRes) return; // over-consume past the cap is fine — reads gate, this only counts
    console.warn('[RateLimit] Domain budget count failed:', err instanceof Error ? err.message : err);
  }
}

/** The registration cap applied to non-provider domains (read-side gate). */
export function domainRegistrationCap(): number {
  return getConfig('registerDomain').points;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export const rateLimitLogin = createMiddleware('login', byIp);
export const rateLimitRegister = createMiddleware('register', byIp);
export const rateLimitRegisterAttempt = createMiddleware('registerAttempt', byIp);
export const rateLimitRegisterAttemptSubnet = createMiddleware('registerAttemptSubnet', bySubnet);
export const rateLimitPowChallenge = createMiddleware('powChallenge', byIp);
export const rateLimitForgotPassword = createMiddleware('forgotPassword', byIp);
export const rateLimitResetPassword = createMiddleware('resetPassword', byIp);
export const rateLimitRefresh = createMiddleware('refresh', byIp);
export const rateLimitChangePassword = createMiddleware('changePassword', byIp);
export const rateLimitMessageSend = createMiddleware('messageSend', byUserId);
export const rateLimitUpload = createMiddleware('upload', byUserId);
export const rateLimitFriendRequest = createMiddleware('friendRequest', byUserId);
export const rateLimitMemberManage = createMiddleware('memberManage', byUserId);
export const rateLimitCategoryManage = createMiddleware('categoryManage', byUserId);
export const rateLimitSearch = createMiddleware('search', byUserId);
export const rateLimitStats = createMiddleware('stats', byIp);
export const rateLimitAdmin = createMiddleware('admin', byUserId);
export const rateLimitReport = createMiddleware('report', byUserId);
export const rateLimitSupport = createMiddleware('support', byUserId);
export const rateLimitTOTP = createMiddleware('totp', byUserId);
export const rateLimitVerifyEmail = createMiddleware('verifyEmail', byIp);
export const rateLimitResendVerification = createMiddleware('resendVerification', byUserId);
export const rateLimitMarkRead = createMiddleware('markRead', byUserId);
export const rateLimitRoleManage = createMiddleware('roleManage', byUserId);
export const rateLimitSecureChannelManage = createMiddleware('secureChannelManage', byUserId);
export const rateLimitGeneral = createMiddleware('general', byIp);
// Authenticated message interactions (edit/delete/react). Keyed by userId — the
// old per-route rateLimitGeneral shared ONE IP bucket with the global api-level
// limiter, so users behind a NAT split a halved 429 budget between them.
export const rateLimitInteract = createMiddleware('interact', byUserId);
export const rateLimitThemeManage = createMiddleware('themeManage', byUserId);
export const rateLimitThemeBrowse = createMiddleware('themeBrowse', byUserId);
export const rateLimitE2EDevice = createMiddleware('e2eDevice', byUserId);
export const rateLimitE2EKeys = createMiddleware('e2eKeys', byUserId);
export const rateLimitE2EBundle = createMiddleware('e2eBundle', byUserId);
export const rateLimitE2EStatus = createMiddleware('e2eStatus', byUserId);
export const rateLimitE2EShares = createMiddleware('e2eShares', byUserId);
export const rateLimitE2EApprove = createMiddleware('e2eApprove', byUserId);

// ─── Socket.IO rate limiting ─────────────────────────────────────────────────

const socketBuckets = new WeakMap<object, Map<string, { count: number; resetAt: number }>>();

/**
 * Per-socket, per-event rate limiter for Socket.IO events.
 * Returns true if the event should be allowed, false if rate-limited.
 */
export function socketRateLimit(socket: object, event: string, maxPerMinute: number): boolean {
  let buckets = socketBuckets.get(socket);
  if (!buckets) {
    buckets = new Map();
    socketBuckets.set(socket, buckets);
  }

  const now = Date.now();
  let bucket = buckets.get(event);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    buckets.set(event, bucket);
  }

  bucket.count++;
  return bucket.count <= maxPerMinute;
}

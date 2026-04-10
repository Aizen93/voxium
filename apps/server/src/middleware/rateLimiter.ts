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
  general:        { keyPrefix: 'rl:general',   points: 100, duration: 60,  blockDuration: 0,   keyType: 'ip',     label: 'General' },
  themeManage:    { keyPrefix: 'rl:theme',     points: 20,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Theme Manage' },
  themeBrowse:    { keyPrefix: 'rl:themebr',   points: 30,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Theme Browse' },
  emojiManage:    { keyPrefix: 'rl:emoji',     points: 15,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Emoji Manage' },
  stickerManage:  { keyPrefix: 'rl:sticker',   points: 15,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Sticker Manage' },
  gifSearch:      { keyPrefix: 'rl:gifsrch',   points: 30,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'GIF Search' },
  collabDoc:      { keyPrefix: 'rl:collab',    points: 30,  duration: 60,  blockDuration: 0,   keyType: 'userId', label: 'Collab Document' },
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

const byIp = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';
const byUserId = (req: Request) => req.user?.userId || req.ip || 'unknown';

// ─── Exports ─────────────────────────────────────────────────────────────────

export const rateLimitLogin = createMiddleware('login', byIp);
export const rateLimitRegister = createMiddleware('register', byIp);
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
export const rateLimitGeneral = createMiddleware('general', byIp);
export const rateLimitThemeManage = createMiddleware('themeManage', byUserId);
export const rateLimitThemeBrowse = createMiddleware('themeBrowse', byUserId);
export const rateLimitEmojiManage = createMiddleware('emojiManage', byUserId);
export const rateLimitStickerManage = createMiddleware('stickerManage', byUserId);
export const rateLimitGifSearch = createMiddleware('gifSearch', byUserId);
export const rateLimitCollabDoc = createMiddleware('collabDoc', byUserId);

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

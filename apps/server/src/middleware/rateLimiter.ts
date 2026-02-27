import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getRedis } from '../utils/redis';

// ─── Lazy-initialized limiters ──────────────────────────────────────────────

let _loginLimiter: RateLimiterRedis | null = null;
let _registerLimiter: RateLimiterRedis | null = null;
let _forgotPasswordLimiter: RateLimiterRedis | null = null;
let _resetPasswordLimiter: RateLimiterRedis | null = null;
let _refreshLimiter: RateLimiterRedis | null = null;
let _changePasswordLimiter: RateLimiterRedis | null = null;
let _messageSendLimiter: RateLimiterRedis | null = null;
let _uploadLimiter: RateLimiterRedis | null = null;
let _friendRequestLimiter: RateLimiterRedis | null = null;
let _generalLimiter: RateLimiterRedis | null = null;

function createLimiter(opts: {
  keyPrefix: string;
  points: number;
  duration: number;
  blockDuration?: number;
}): RateLimiterRedis {
  // Each limiter gets its own in-memory fallback with matching limits
  const insuranceLimiter = new RateLimiterMemory({
    points: opts.points,
    duration: opts.duration,
    blockDuration: opts.blockDuration ?? 0,
  });

  return new RateLimiterRedis({
    storeClient: getRedis(),
    useRedisPackage: true,
    keyPrefix: opts.keyPrefix,
    points: opts.points,
    duration: opts.duration,
    blockDuration: opts.blockDuration ?? 0,
    insuranceLimiter,
  });
}

function getLoginLimiter() {
  if (!_loginLimiter) _loginLimiter = createLimiter({ keyPrefix: 'rl:login', points: 5, duration: 60, blockDuration: 300 });
  return _loginLimiter;
}

function getRegisterLimiter() {
  if (!_registerLimiter) _registerLimiter = createLimiter({ keyPrefix: 'rl:register', points: 3, duration: 60, blockDuration: 600 });
  return _registerLimiter;
}

function getForgotPasswordLimiter() {
  if (!_forgotPasswordLimiter) _forgotPasswordLimiter = createLimiter({ keyPrefix: 'rl:forgot', points: 3, duration: 900 });
  return _forgotPasswordLimiter;
}

function getResetPasswordLimiter() {
  if (!_resetPasswordLimiter) _resetPasswordLimiter = createLimiter({ keyPrefix: 'rl:reset', points: 5, duration: 900 });
  return _resetPasswordLimiter;
}

function getRefreshLimiter() {
  if (!_refreshLimiter) _refreshLimiter = createLimiter({ keyPrefix: 'rl:refresh', points: 10, duration: 60 });
  return _refreshLimiter;
}

function getChangePasswordLimiter() {
  if (!_changePasswordLimiter) _changePasswordLimiter = createLimiter({ keyPrefix: 'rl:chgpwd', points: 5, duration: 60, blockDuration: 300 });
  return _changePasswordLimiter;
}

function getMessageSendLimiter() {
  if (!_messageSendLimiter) _messageSendLimiter = createLimiter({ keyPrefix: 'rl:msg', points: 30, duration: 60 });
  return _messageSendLimiter;
}

function getUploadLimiter() {
  if (!_uploadLimiter) _uploadLimiter = createLimiter({ keyPrefix: 'rl:upload', points: 10, duration: 60 });
  return _uploadLimiter;
}

function getFriendRequestLimiter() {
  if (!_friendRequestLimiter) _friendRequestLimiter = createLimiter({ keyPrefix: 'rl:friend', points: 20, duration: 60 });
  return _friendRequestLimiter;
}

function getGeneralLimiter() {
  if (!_generalLimiter) _generalLimiter = createLimiter({ keyPrefix: 'rl:general', points: 100, duration: 60 });
  return _generalLimiter;
}

// ─── Middleware factories ────────────────────────────────────────────────────

function createMiddleware(
  getLimiter: () => RateLimiterRedis,
  keyFn: (req: Request) => string,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await getLimiter().consume(keyFn(req));
      next();
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(err.msBeforeNext / 1000);
        res.set('Retry-After', String(retryAfter));
        res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
        return;
      }
      // Redis error or unexpected — fail open
      next();
    }
  };
}

const byIp = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';
const byUserId = (req: Request) => req.user?.userId || req.ip || 'unknown';

// ─── Exports ─────────────────────────────────────────────────────────────────

export const rateLimitLogin = createMiddleware(getLoginLimiter, byIp);
export const rateLimitRegister = createMiddleware(getRegisterLimiter, byIp);
export const rateLimitForgotPassword = createMiddleware(getForgotPasswordLimiter, byIp);
export const rateLimitResetPassword = createMiddleware(getResetPasswordLimiter, byIp);
export const rateLimitRefresh = createMiddleware(getRefreshLimiter, byIp);
export const rateLimitChangePassword = createMiddleware(getChangePasswordLimiter, byIp);
export const rateLimitMessageSend = createMiddleware(getMessageSendLimiter, byUserId);
export const rateLimitUpload = createMiddleware(getUploadLimiter, byUserId);
export const rateLimitFriendRequest = createMiddleware(getFriendRequestLimiter, byUserId);
export const rateLimitGeneral = createMiddleware(getGeneralLimiter, byIp);

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

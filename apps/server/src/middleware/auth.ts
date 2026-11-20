import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { isJwtVerifyError } from '../utils/jwtErrors';
import { loadAccessState, readAccessSessionId } from '../services/sessionService';
import { hasAccessTokenShape } from '../utils/tokenShapes';
import type { UserRole } from '@voxium/shared';

export interface AuthPayload {
  userId: string;
  username: string;
  role: UserRole;
  tokenVersion: number;
  /** The sign-in session the access token belongs to (its `sid`); absent on a token issued before sessions. */
  sid?: string;
  rememberMe?: boolean;
  emailVerified?: boolean;
  /** Resolved from the DB on every request, like emailVerified: true until
   *  the account has accepted BOTH the Terms of Service and the Privacy
   *  Policy. Accounts that predate consent-at-signup start out here. */
  consentRequired?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      /** Unique request identifier for log correlation (set by X-Request-ID middleware) */
      id?: string;
    }
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing or invalid authorization header'));
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as AuthPayload & { purpose?: string; sid?: unknown };

    // Reject non-access tokens (a trusted-device or a two-factor token, a
    // refresh token: utils/tokenShapes.ts), whatever the secrets are
    if (!hasAccessTokenShape(payload)) {
      return next(new UnauthorizedError('Invalid token type'));
    }

    // The session the token names (services/sessionService.ts); a value no
    // signer of ours writes is no session at all
    const sid = readAccessSessionId(payload);
    if (sid === null) return next(new UnauthorizedError('Invalid or expired token'));

    // Account ban, token version, current role and, for a token naming a
    // session, that session's row: one statement
    const user = await loadAccessState(payload.userId, sid);

    if (!user) return next(new UnauthorizedError('User not found'));
    if (user.bannedAt) return next(new ForbiddenError('Your account has been banned'));
    if (user.tokenVersion !== payload.tokenVersion) {
      return next(new UnauthorizedError('Session invalidated'));
    }
    // Signed out, ended or evicted: the access token dies with its session
    // instead of living out its minutes (the client renews, is refused, and
    // signs out). A token issued before sessions carries no `sid` and keeps
    // the account checks alone.
    if (user.sessionLive === false) {
      return next(new UnauthorizedError('Session invalidated'));
    }

    // Use DB role (not JWT role) so role changes take effect immediately
    req.user = {
      ...payload,
      sid,
      role: user.role as UserRole,
      emailVerified: user.emailVerified,
      consentRequired: consentIsRequired(user),
    };
    next();
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof UnauthorizedError) {
      return next(err);
    }
    // Only a token jsonwebtoken refused is a 401. The user lookup failing
    // (pool exhausted, database down) used to answer 401 as well, and the
    // client reads a 401 as "renew, then sign out when that fails too": a
    // database blip signed everyone out. It surfaces as the 500 it is, and
    // the client keeps the session for a later attempt.
    if (isJwtVerifyError(err)) {
      return next(new UnauthorizedError('Invalid or expired token'));
    }
    next(err);
  }
}

/** Middleware that blocks unverified users. Apply after authenticate(). */
export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.emailVerified) {
    return next(new ForbiddenError('Email not verified'));
  }
  next();
}

/** Has this account accepted both legal documents? Null timestamps mean it
 *  has not — accounts created before consent was collected at signup. */
export function consentIsRequired(user: { termsAcceptedAt: Date | null; privacyAcceptedAt: Date | null }): boolean {
  return !user.termsAcceptedAt || !user.privacyAcceptedAt;
}

export const CONSENT_REQUIRED_MESSAGE = 'You must accept the Terms of Service and the Privacy Policy to continue';

/**
 * Middleware that blocks accounts that have not accepted the Terms of Service
 * and the Privacy Policy (CNIL/GDPR — consent is collected at signup, and
 * accounts that predate that step have to give it before using anything).
 * Applied wherever requireVerifiedEmail is: every functional route and the
 * socket. The auth self-management routes stay open, because POST
 * /auth/consent is how the gate is cleared.
 */
export function requireConsent(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.consentRequired) {
    return next(new ForbiddenError(CONSENT_REQUIRED_MESSAGE));
  }
  next();
}

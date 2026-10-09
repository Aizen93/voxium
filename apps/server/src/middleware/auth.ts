import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { prisma } from '../utils/prisma';
import type { UserRole } from '@voxium/shared';

export interface AuthPayload {
  userId: string;
  username: string;
  role: UserRole;
  tokenVersion: number;
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
    const payload = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as AuthPayload & { purpose?: string };

    // Reject non-access tokens (e.g. trusted-device, totp-verify)
    if (payload.purpose) {
      return next(new UnauthorizedError('Invalid token type'));
    }

    // Check account ban, token version, and current role against DB
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { bannedAt: true, tokenVersion: true, role: true, emailVerified: true, termsAcceptedAt: true, privacyAcceptedAt: true },
    });

    if (!user) return next(new UnauthorizedError('User not found'));
    if (user.bannedAt) return next(new ForbiddenError('Your account has been banned'));
    if (user.tokenVersion !== payload.tokenVersion) {
      return next(new UnauthorizedError('Session invalidated'));
    }

    // Use DB role (not JWT role) so role changes take effect immediately
    req.user = {
      ...payload,
      role: user.role as UserRole,
      emailVerified: user.emailVerified,
      consentRequired: consentIsRequired(user),
    };
    next();
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof UnauthorizedError) {
      return next(err);
    }
    next(new UnauthorizedError('Invalid or expired token'));
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

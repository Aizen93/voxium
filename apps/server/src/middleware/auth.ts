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
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
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
      select: { bannedAt: true, tokenVersion: true, role: true, emailVerified: true },
    });

    if (!user) return next(new UnauthorizedError('User not found'));
    if (user.bannedAt) return next(new ForbiddenError('Your account has been banned'));
    if (user.tokenVersion !== payload.tokenVersion) {
      return next(new UnauthorizedError('Session invalidated'));
    }

    // Use DB role (not JWT role) so role changes take effect immediately
    req.user = { ...payload, role: user.role as UserRole, emailVerified: user.emailVerified };
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

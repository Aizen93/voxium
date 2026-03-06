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
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;

    // Check account ban, token version, and current role against DB
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { bannedAt: true, tokenVersion: true, role: true },
    });

    if (!user) return next(new UnauthorizedError('User not found'));
    if (user.bannedAt) return next(new ForbiddenError('Your account has been banned'));
    if (user.tokenVersion !== payload.tokenVersion) {
      return next(new UnauthorizedError('Session invalidated'));
    }

    // Use DB role (not JWT role) so role changes take effect immediately
    req.user = { ...payload, role: user.role as UserRole };
    next();
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof UnauthorizedError) {
      return next(err);
    }
    next(new UnauthorizedError('Invalid or expired token'));
  }
}

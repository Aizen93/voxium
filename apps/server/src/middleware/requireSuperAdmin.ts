import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../utils/errors';

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'superadmin') {
    return next(new ForbiddenError('Super admin access required'));
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
    return next(new ForbiddenError('Admin access required'));
  }
  next();
}

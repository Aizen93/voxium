import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../utils/errors';
import { isFeatureEnabled } from '../utils/featureFlags';

/**
 * A feature flag's kill switch as route middleware: while the flag is off,
 * every request it guards answers 403 with `message` (clients may key on that
 * exact text, e.g. 'Server discovery is currently disabled'). Read per request,
 * so an admin toggle propagated through Redis takes effect without a restart.
 */
export function requireFeature(name: string, message: string) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    if (!isFeatureEnabled(name)) {
      next(new ForbiddenError(message));
      return;
    }
    next();
  };
}

import type { Request, Response, NextFunction } from 'express';
import { BadRequestError } from '../utils/errors';

export const SINGLE_VALUE_QUERY_MESSAGE = 'Each query parameter must be a single value';

/**
 * Every query parameter carries ONE string value, on every API route: the
 * rule is applied once, on app.ts's api router, right after the general rate
 * limiter and before every route under it. The incoming-webhook execute route,
 * the health probes and the public feature flags sit outside that router (the
 * execute route reads `wait` only as a comparison with 'true').
 *
 * Express 5's query parser ('simple', pinned in app.ts) hands a repeated
 * parameter (`?around=a&around=b`) to the route as an array of strings; the
 * 'extended' parser would also produce nested objects (`?a[b]=1`). No route
 * accepts either shape: every query read is a string read (a cast, a
 * comparison with a literal, a validator), so a non-string value either
 * reached a `.trim()` or a Prisma `where` (a 500) or was silently ignored.
 * Past this middleware every value in `req.query` is a string, which is what
 * those reads rely on. `req.query` is a getter that parses the URL on each
 * access, so the rule refuses rather than normalises.
 */
export function requireSingleValueQuery(req: Request, _res: Response, next: NextFunction): void {
  const query = req.query as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (typeof query[key] !== 'string') {
      next(new BadRequestError(SINGLE_VALUE_QUERY_MESSAGE));
      return;
    }
  }
  next();
}

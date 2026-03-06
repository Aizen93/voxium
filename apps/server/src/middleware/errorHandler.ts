import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
  }

  if (process.env.NODE_ENV === 'production') {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: err.message, stack: err.stack }));
  } else {
    console.error('[Error]', err);
  }

  return res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}

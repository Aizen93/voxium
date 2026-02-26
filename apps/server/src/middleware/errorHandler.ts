import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { AppError } from '../utils/errors';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  // Multer file-size / unexpected-field errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'File too large (max 5 MB)' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ success: false, error: 'Unexpected file field' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
  }

  console.error('[Error]', err);

  return res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}

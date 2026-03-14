import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from '../../utils/errors';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express app that throws the given error and uses the
 * errorHandler middleware. This isolates the error handler from the full
 * app middleware stack.
 */
function buildApp(error: Error) {
  const app = express();
  app.get('/test', (_req, _res) => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('errorHandler middleware', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.error output during tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it('AppError returns its statusCode and message', async () => {
    const error = new AppError('Custom app error', 418);
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(418);
    expect(res.body).toEqual({
      success: false,
      error: 'Custom app error',
    });
  });

  it('BadRequestError returns 400', async () => {
    const error = new BadRequestError('Invalid input data');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Invalid input data',
    });
  });

  it('UnauthorizedError returns 401', async () => {
    const error = new UnauthorizedError('Not authenticated');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: 'Not authenticated',
    });
  });

  it('UnauthorizedError with default message returns 401', async () => {
    const error = new UnauthorizedError();
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: 'Unauthorized',
    });
  });

  it('ForbiddenError returns 403', async () => {
    const error = new ForbiddenError('Access denied');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: 'Access denied',
    });
  });

  it('ForbiddenError with default message returns 403', async () => {
    const error = new ForbiddenError();
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: 'Forbidden',
    });
  });

  it('NotFoundError returns 404', async () => {
    const error = new NotFoundError('Channel');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: 'Channel not found',
    });
  });

  it('ConflictError returns 409', async () => {
    const error = new ConflictError('Username or email already in use');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: 'Username or email already in use',
    });
  });

  it('Unknown Error returns 500 with generic message', async () => {
    const error = new Error('Something broke internally');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: 'Internal server error',
    });
  });

  it('production mode hides error details for unknown errors', async () => {
    process.env.NODE_ENV = 'production';
    const error = new Error('secret database connection string leaked');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: 'Internal server error',
    });
    // The secret detail must not appear in the response
    expect(JSON.stringify(res.body)).not.toContain('secret database');
  });

  it('production mode still returns AppError messages (they are operational)', async () => {
    process.env.NODE_ENV = 'production';
    const error = new BadRequestError('Missing required field');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Missing required field',
    });
  });

  it('logs to console.error for non-AppError errors', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Unexpected failure');
    const app = buildApp(error);

    await request(app).get('/test');

    expect(consoleSpy).toHaveBeenCalled();
  });

  it('handles TypeError (non-operational) as 500', async () => {
    const error = new TypeError('Cannot read properties of undefined');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: 'Internal server error',
    });
  });

  it('handles RangeError (non-operational) as 500', async () => {
    const error = new RangeError('Maximum call stack size exceeded');
    const app = buildApp(error);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: 'Internal server error',
    });
  });

  it('AppError instances have isOperational set to true', () => {
    const error = new AppError('test', 500);
    expect(error.isOperational).toBe(true);
  });

  it('AppError subclasses inherit isOperational', () => {
    expect(new BadRequestError('test').isOperational).toBe(true);
    expect(new UnauthorizedError().isOperational).toBe(true);
    expect(new ForbiddenError().isOperational).toBe(true);
    expect(new NotFoundError('X').isOperational).toBe(true);
    expect(new ConflictError('test').isOperational).toBe(true);
  });
});

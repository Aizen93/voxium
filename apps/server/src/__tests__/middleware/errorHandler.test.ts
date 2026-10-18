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
    const error = new Error('Unexpected failure');
    const app = buildApp(error);

    await request(app).get('/test');

    expect(console.error).toHaveBeenCalled();
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

// ─── Exposed http-errors (body-parser failures) ──────────────────────────────

/** The shape body-parser's http-errors carry (built by hand: http-errors is
 *  not a direct dependency). `message` deliberately carries "body" text. */
function httpError(status: number, type: string | undefined, expose: boolean): Error {
  return Object.assign(new Error('Unexpected token } in JSON at position 7: {"secret":"BODYFRAGMENT"}'), {
    status,
    statusCode: status,
    expose,
    ...(type !== undefined && { type }),
  });
}

describe('errorHandler middleware — exposed client http-errors', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [413, 'entity.too.large', 'Request body too large'],
    [400, 'entity.parse.failed', 'Malformed JSON body'],
    [415, 'charset.unsupported', 'Unsupported request encoding'],
    [415, 'encoding.unsupported', 'Unsupported request encoding'],
  ])('maps %i %s to a fixed sentence in the house shape, with no console.error', async (status, type, message) => {
    const res = await request(buildApp(httpError(status, type, true))).get('/test');

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ success: false, error: message });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('never echoes err.message (a parse error carries body fragments)', async () => {
    const res = await request(buildApp(httpError(400, 'entity.parse.failed', true))).get('/test');

    expect(res.text).not.toContain('BODYFRAGMENT');
    expect(res.text).not.toContain('Unexpected token');
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain('BODYFRAGMENT');
  });

  it('logs ONE console.warn with method, path and status — no body, no stack', async () => {
    await request(buildApp(httpError(413, 'entity.too.large', true))).get('/test');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [label, details] = warnSpy.mock.calls[0];
    expect(label).toBe('[HTTP] Rejected request');
    expect(details).toEqual({ method: 'GET', path: '/test', status: 413 });
  });

  it('redacts a webhook token and drops the query string from the logged path', async () => {
    const app = express();
    app.post('/api/v1/webhooks/:id/:token', () => {
      throw httpError(413, 'entity.too.large', true);
    });
    app.use(errorHandler);

    await request(app).post('/api/v1/webhooks/wh_abc/SECRETTOKEN?wait=true&token=QUERYSECRET');

    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('/api/v1/webhooks/wh_abc/[redacted]');
    expect(logged).not.toContain('SECRETTOKEN');
    expect(logged).not.toContain('QUERYSECRET');
  });

  it('an exposed 4xx with an unknown type answers its status and "Invalid request"', async () => {
    const res = await request(buildApp(httpError(400, 'request.size.invalid', true))).get('/test');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Invalid request' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('an exposed 4xx without a type answers "Invalid request"', async () => {
    const res = await request(buildApp(httpError(422, undefined, true))).get('/test');

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ success: false, error: 'Invalid request' });
  });

  it('a type naming an Object.prototype member still answers "Invalid request"', async () => {
    const res = await request(buildApp(httpError(400, 'constructor', true))).get('/test');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Invalid request' });
  });

  it('a NON-exposed error with a 4xx status still answers 500 and is logged', async () => {
    const res = await request(buildApp(httpError(400, 'entity.parse.failed', false))).get('/test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('an exposed error with a 5xx status is not treated as a client error', async () => {
    const res = await request(buildApp(httpError(503, 'stream.not.readable', true))).get('/test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('a non-numeric status is not treated as a client error', async () => {
    const error = Object.assign(new Error('weird'), { status: '413', expose: true, type: 'entity.too.large' });
    const res = await request(buildApp(error)).get('/test');

    expect(res.status).toBe(500);
  });

  it('an unknown error still answers 500', async () => {
    const res = await request(buildApp(new Error('boom'))).get('/test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
  });

  it('AppError handling is unchanged (its message, its status, nothing logged)', async () => {
    const res = await request(buildApp(new AppError('Webhook is disabled', 403))).get('/test');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Webhook is disabled' });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── Malformed percent-escapes in the URL ─────────────────────────────────────

/** What Express 5's router throws while decoding a route param: a URIError
 *  whose message quotes the raw (possibly credential) segment, status 400. */
function routerDecodeError(withStatus: boolean): URIError {
  const err = new URIError("Failed to decode param 'SECRETSEGMENT%zz'");
  if (withStatus) Object.assign(err, { status: 400 });
  return err;
}

describe('errorHandler middleware — malformed URL (router param decoding)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a URIError with status 400 answers 400 "Malformed URL" in the house shape, with no console.error', async () => {
    const res = await request(buildApp(routerDecodeError(true))).get('/test');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Malformed URL' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs ONE console.warn with method, path and status — never the message, never a stack', async () => {
    await request(buildApp(routerDecodeError(true))).get('/test');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toEqual(['[HTTP] Malformed URL', { method: 'GET', path: '/test', status: 400 }]);
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain('SECRETSEGMENT');
    expect(logged).not.toContain('Failed to decode');
    expect(logged).not.toContain('at ');
  });

  it('never echoes the message to the client', async () => {
    const res = await request(buildApp(routerDecodeError(true))).get('/test');

    expect(res.text).not.toContain('SECRETSEGMENT');
  });

  it('an error NAMED URIError with status 400 (another realm) gets the same answer', async () => {
    const err = Object.assign(new Error("Failed to decode param 'SECRETSEGMENT%zz'"), { name: 'URIError', status: 400 });

    const res = await request(buildApp(err)).get('/test');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Malformed URL' });
  });

  it('a URIError WITHOUT a status is still a 500 (a decode bug in our own code)', async () => {
    const res = await request(buildApp(routerDecodeError(false))).get('/test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a URIError with another status is not treated as a malformed URL', async () => {
    const res = await request(buildApp(Object.assign(new URIError('x'), { status: 500 }))).get('/test');

    expect(res.status).toBe(500);
  });

  it('a 400 that is not a URIError is unchanged (500 unless exposed)', async () => {
    const res = await request(buildApp(Object.assign(new Error('x'), { status: 400 }))).get('/test');

    expect(res.status).toBe(500);
  });

  it("end to end: Express's own decoding of a bad escape in a token segment answers 400, redacted", async () => {
    const app = express();
    app.post('/api/v1/webhooks/:webhookId/:token', (_req, res) => {
      res.status(204).end();
    });
    app.use(errorHandler);

    const res = await request(app).post('/api/v1/webhooks/wh_abc/SECRETTOKEN%zz?wait=true');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Malformed URL' });
    expect(errorSpy).not.toHaveBeenCalled();
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('/api/v1/webhooks/wh_abc/[redacted]');
    expect(logged).not.toContain('SECRETTOKEN');
  });
});

describe('errorHandler middleware — with the real express.json parser', () => {
  function parserApp() {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/test', (req, res) => {
      res.json({ success: true, data: req.body });
    });
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a 2 KB body above a 1 KB limit answers 413 in the house shape', async () => {
    const res = await request(parserApp())
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(2048) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, error: 'Request body too large' });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('malformed JSON answers 400 in the house shape, echoing nothing', async () => {
    const res = await request(parserApp())
      .post('/test')
      .set('Content-Type', 'application/json')
      .send('{"secret": "BODYFRAGMENT",');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Malformed JSON body' });
    expect(res.text).not.toContain('BODYFRAGMENT');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('an unsupported charset answers 415 in the house shape', async () => {
    const res = await request(parserApp())
      .post('/test')
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{}');

    expect(res.status).toBe(415);
    expect(res.body).toEqual({ success: false, error: 'Unsupported request encoding' });
  });

  it('a valid body under the limit is parsed normally', async () => {
    const res = await request(parserApp())
      .post('/test')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ok: 1 }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: 1 } });
  });
});

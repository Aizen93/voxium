import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { inspect } from 'util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../../generated/prisma/client';
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

// ─── What an unexpected error is logged with ────────────────────────────────

/** What nodemailer rejects with when the relay refuses a recipient: the
 *  recipient address rides on the error object AND in its message, which
 *  quotes the server's reply. */
function mailTransportError(): Error {
  return Object.assign(new Error('Can\'t send mail - all recipients were rejected: 550 5.1.1 <someone.private@example.org>: Recipient address rejected'), {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode: 550,
    envelope: { from: 'noreply@voxium.example', to: ['someone.private@example.org'] },
    rejected: ['someone.private@example.org'],
    response: '550 5.1.1 <someone.private@example.org>: Recipient address rejected',
  });
}

describe('errorHandler middleware — an unexpected error is logged as its message and stack only', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  for (const mode of ['development', 'test', 'production']) {
    it(`${mode}: prints strings only, and none of the error's other properties`, async () => {
      process.env.NODE_ENV = mode;
      const error = mailTransportError();

      const res = await request(buildApp(error)).get('/test');

      expect(res.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      // Printing the object prints `.envelope`, `.rejected` and `.response`;
      // the message and the stack's first line quote the refused address
      for (const arg of errorSpy.mock.calls[0]) expect(typeof arg).toBe('string');
      const logged = errorSpy.mock.calls[0].join(' ');
      expect(logged).not.toContain('someone.private@example.org');
      expect(logged).not.toContain('all recipients were rejected');
      // What is left: the name, the code, describeEmailError's codes, the frames
      expect(logged).toContain('EENVELOPE (SMTP 550)');
      expect(logged).toContain('Error');
      expect(logged).toContain(error.stack!.split('\n')[1].trim());
    });
  }

  it('outside production, the line is the label, name and message, then the stack', async () => {
    process.env.NODE_ENV = 'development';
    const error = new Error('Something broke internally');

    await request(buildApp(error)).get('/test');

    expect(errorSpy.mock.calls[0]).toEqual(['[Error]', 'Error: Something broke internally', error.stack]);
  });

  it('keeps the error\'s name and a string code, in both modes', async () => {
    const error = Object.assign(new TypeError('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED', errno: -111 });

    process.env.NODE_ENV = 'development';
    await request(buildApp(error)).get('/test');
    expect(errorSpy.mock.calls[0]).toEqual(['[Error]', 'TypeError [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:6379', error.stack]);

    process.env.NODE_ENV = 'production';
    await request(buildApp(error)).get('/test');
    const line = JSON.parse(errorSpy.mock.calls[1][0] as string);
    expect(line).toMatchObject({ level: 'error', name: 'TypeError', code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:6379', stack: error.stack });
  });

  it('a code that is not a string is left out, never printed as a value', async () => {
    process.env.NODE_ENV = 'production';
    const error = Object.assign(new Error('boom'), { code: { detail: 'someone.private@example.org' } });

    await request(buildApp(error)).get('/test');

    const line = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(line.code).toBeUndefined();
    expect(errorSpy.mock.calls[0][0]).not.toContain('someone.private@example.org');
  });

  it('in production an SMTP error is described by its codes, and its stack keeps only the frames', async () => {
    process.env.NODE_ENV = 'production';
    const error = mailTransportError();

    await request(buildApp(error)).get('/test');

    const line = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(line).toMatchObject({ name: 'Error', code: 'EENVELOPE', message: 'EENVELOPE (SMTP 550)' });
    expect(line.stack.split('\n').every((l: string) => /^\s+at /.test(l))).toBe(true);
    expect(errorSpy.mock.calls[0][0]).not.toContain('someone.private@example.org');
  });

  it('an error carrying only responseCode is treated as an SMTP error too', async () => {
    process.env.NODE_ENV = 'development';
    const error = Object.assign(new Error('Invalid login: 535 5.7.8 <someone.private@example.org> rejected'), { responseCode: 535 });

    await request(buildApp(error)).get('/test');

    expect(errorSpy.mock.calls[0].join(' ')).not.toContain('someone.private@example.org');
  });

  it('a thrown value that is not an error is named by its type, never printed', async () => {
    process.env.NODE_ENV = 'development';
    const app = express();
    app.get('/test', () => {
      throw { to: 'someone.private@example.org' };
    });
    app.use(errorHandler);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(errorSpy.mock.calls[0]).toEqual(['[Error]', 'Error: Non-error value thrown (object)', '']);
  });
});

// ─── Prisma errors print the call's arguments ────────────────────────────────

describe('errorHandler middleware — a Prisma error is logged without the arguments of the call', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const SECRET_EMAIL = 'someone.private@example.org';
  const SECRET_HASH = '$2a$12$abcdefghijklmnopqrstuuvwxyz0123456789ABCDEFGHIJKLMNO';
  let errorSpy: ReturnType<typeof vi.spyOn>;

  /** A REAL validation error: the generated client refuses the call before any connection is made. */
  async function realValidationError(): Promise<Error> {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/none' }) });
    try {
      await prisma.user.update({
        where: { email: SECRET_EMAIL },
        data: { password: SECRET_HASH, notAColumn: true } as never,
      });
      throw new Error('expected a validation error');
    } catch (err) {
      return err as Error;
    } finally {
      await prisma.$disconnect();
    }
  }

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it('the real error does carry the secrets, in its message and its stack (the premise)', async () => {
    const error = await realValidationError();

    expect(error).toBeInstanceOf(Prisma.PrismaClientValidationError);
    expect(error.message).toContain(SECRET_EMAIL);
    expect(error.stack).toContain(SECRET_HASH);
  });

  for (const mode of ['development', 'production']) {
    it(`${mode}: logs its name and the operation, never the message or the stack lines that quote the arguments`, async () => {
      process.env.NODE_ENV = mode;
      const error = await realValidationError();

      const res = await request(buildApp(error)).get('/test');

      expect(res.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls[0].join(' ');
      expect(logged).not.toContain(SECRET_EMAIL);
      expect(logged).not.toContain(SECRET_HASH);
      expect(logged).not.toContain('notAColumn');
      expect(logged).toContain('PrismaClientValidationError');
      expect(logged).toContain('user.update() failed (arguments not logged)');
    });
  }

  it('a known request error is logged by its name, its code and its model, never its message', async () => {
    process.env.NODE_ENV = 'production';
    const error = new Prisma.PrismaClientKnownRequestError(
      `\nInvalid \`prisma.user.create()\` invocation:\n\n{ data: { email: "${SECRET_EMAIL}", password: "${SECRET_HASH}" } }\n\nUnique constraint failed on the fields: (\`email\`)`,
      { code: 'P2002', clientVersion: '7.0.0', meta: { modelName: 'User', target: ['email'] } },
    );

    await request(buildApp(error)).get('/test');

    const line = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(line).toMatchObject({
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      message: 'user.create(), model User failed (arguments not logged)',
    });
    expect(errorSpy.mock.calls[0][0]).not.toContain(SECRET_EMAIL);
    expect(errorSpy.mock.calls[0][0]).not.toContain(SECRET_HASH);
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
    const logged = inspect(warnSpy.mock.calls, { depth: 10 });
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

    const logged = inspect(warnSpy.mock.calls, { depth: 10 });
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
    const logged = inspect(warnSpy.mock.calls, { depth: 10 });
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
    const logged = inspect(warnSpy.mock.calls, { depth: 10 });
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

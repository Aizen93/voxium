import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { isJwtVerifyError, isJwtExpiredError } from '../../utils/jwtErrors';

// The REST middleware, the refresh and the socket handshake answer a TOKEN
// refusal (401 / 'Invalid token' / 'Token expired') and a failing lookup
// (500 / 'Authentication unavailable') differently: the client ends the
// session on the first and retries on the second. This is the line.

const SECRET = 'jwt-errors-test-secret';

async function verifyError(token: string, options?: jwt.VerifyOptions): Promise<unknown> {
  try {
    jwt.verify(token, SECRET, { algorithms: ['HS256'], ...options });
    return null;
  } catch (err) {
    return err;
  }
}

describe('isJwtVerifyError — what jsonwebtoken itself throws', () => {
  it('a malformed token', async () => {
    const err = await verifyError('not-a-token');
    expect(err).not.toBeNull();
    expect(isJwtVerifyError(err)).toBe(true);
    expect(isJwtExpiredError(err)).toBe(false);
  });

  it('a bad signature', async () => {
    const token = jwt.sign({ userId: 'u-1' }, 'another-secret', { algorithm: 'HS256' });
    expect(isJwtVerifyError(await verifyError(token))).toBe(true);
  });

  it('an expired token — the one refusal a refresh repairs', async () => {
    const token = jwt.sign({ userId: 'u-1' }, SECRET, { algorithm: 'HS256', expiresIn: '0s' });
    await new Promise((r) => setTimeout(r, 20));
    const err = await verifyError(token);
    expect(isJwtVerifyError(err)).toBe(true);
    expect(isJwtExpiredError(err)).toBe(true);
  });

  it('a token not yet valid', async () => {
    const token = jwt.sign({ userId: 'u-1' }, SECRET, { algorithm: 'HS256', notBefore: '1h' });
    const err = await verifyError(token);
    expect(isJwtVerifyError(err)).toBe(true);
    expect(isJwtExpiredError(err)).toBe(false);
  });

  it('matches on the name alone, the way a module mock would throw it', () => {
    expect(isJwtVerifyError(Object.assign(new Error('jwt malformed'), { name: 'JsonWebTokenError' }))).toBe(true);
    expect(isJwtExpiredError(Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' }))).toBe(true);
  });
});

describe('isJwtVerifyError — what is NOT the token', () => {
  it('a database failure, a plain error, a non-error', () => {
    for (const err of [
      Object.assign(new Error("Can't reach database server"), { name: 'PrismaClientInitializationError' }),
      new Error('pool timeout'),
      new TypeError('x is not a function'),
      'a string',
      null,
      undefined,
      { name: 42 },
    ]) {
      expect(isJwtVerifyError(err)).toBe(false);
      expect(isJwtExpiredError(err)).toBe(false);
    }
  });
});

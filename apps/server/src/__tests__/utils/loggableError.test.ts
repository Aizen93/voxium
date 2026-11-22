import { describe, it, expect } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../../generated/prisma/client';
import {
  loggableError,
  describeCaughtError,
  describeCaughtErrorWithStack,
  describePrismaError,
} from '../../utils/loggableError';

const SECRET_EMAIL = 'someone.private@example.org';
const SECRET_HASH = '$2a$12$abcdefghijklmnopqrstuuvwxyz0123456789ABCDEFGHIJKLMNO';

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

function smtpError(): Error {
  return Object.assign(new Error('550 5.1.1 <victim@example.com>: Recipient address rejected'), {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode: 550,
    envelope: { to: ['victim@example.com'] },
  });
}

describe('loggableError', () => {
  it('a real Prisma validation error: name, operation and frames, never the message', async () => {
    const error = await realValidationError();
    expect(error.message).toContain(SECRET_EMAIL); // the premise
    const out = loggableError(error);
    expect(out.name).toBe('PrismaClientValidationError');
    expect(out.message).toBe('user.update() failed (arguments not logged)');
    const all = JSON.stringify(out);
    expect(all).not.toContain(SECRET_EMAIL);
    expect(all).not.toContain(SECRET_HASH);
    expect(out.stack?.split('\n').every((l) => /^\s+at \S/.test(l))).toBe(true);
  });

  it('a known request error: name, code, operation and model', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      `\nInvalid \`prisma.user.create()\` invocation:\n\n{ data: { email: "${SECRET_EMAIL}" } }\n\nUnique constraint failed`,
      { code: 'P2002', clientVersion: '7.0.0', meta: { modelName: 'User', target: ['email'] } },
    );
    expect(loggableError(error)).toMatchObject({
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      message: 'user.create(), model User failed (arguments not logged)',
    });
    expect(JSON.stringify(loggableError(error))).not.toContain(SECRET_EMAIL);
  });

  it('an unknown request error and a panic are described by name, never their text', () => {
    const unknown = new Prisma.PrismaClientUnknownRequestError(
      `\nInvalid \`prisma.user.update()\` invocation:\n\n{ where: { email: "${SECRET_EMAIL}" } }`,
      { clientVersion: '7.0.0' },
    );
    expect(loggableError(unknown).message).toBe('user.update() failed (arguments not logged)');
    const panic = new Prisma.PrismaClientRustPanicError(`PANIC while rendering { email: "${SECRET_EMAIL}" }`, '7.0.0');
    const out = loggableError(panic);
    expect(out.message).toBe('Prisma query failed (arguments not logged)');
    expect(JSON.stringify(out)).not.toContain(SECRET_EMAIL);
  });

  it('a nodemailer error (command / responseCode): its codes, never the reply that names the address', () => {
    const out = loggableError(smtpError());
    expect(out.name).toBe('Error');
    expect(out.code).toBe('EENVELOPE');
    expect(out.message).toBe('EENVELOPE (SMTP 550)');
    expect(JSON.stringify(out)).not.toContain('victim@example.com');
    expect(out.stack?.split('\n').every((l) => /^\s+at \S/.test(l))).toBe(true);
  });

  it('a plain Error keeps its name, string code, message and whole stack', () => {
    const error = Object.assign(new TypeError('boom'), { code: 'ECONNREFUSED' });
    const out = loggableError(error);
    expect(out).toEqual({ name: 'TypeError', code: 'ECONNREFUSED', message: 'boom', stack: error.stack });
  });

  it('a code that is not a string is left out', () => {
    expect(loggableError(Object.assign(new Error('x'), { code: 42 })).code).toBeUndefined();
  });

  it('a string is its own message', () => {
    expect(loggableError('plain text')).toMatchObject({ name: undefined, code: undefined, message: 'plain text', stack: undefined });
  });

  it('null, undefined and other values are named by their type, never printed', () => {
    expect(loggableError(null).message).toBe('Non-error value thrown (null)');
    expect(loggableError(undefined).message).toBe('Non-error value thrown (undefined)');
    expect(loggableError({ token: 'SECRET' }).message).toBe('Non-error value thrown (object)');
    expect(loggableError(42).message).toBe('Non-error value thrown (number)');
  });
});

describe('describePrismaError', () => {
  it('reads the operation and the model, identifier characters only', () => {
    expect(describePrismaError('Invalid `prisma.serverMember.upsert()` invocation: x', { modelName: 'ServerMember' }))
      .toBe('serverMember.upsert(), model ServerMember failed (arguments not logged)');
  });

  it('refuses a model name that is not an identifier', () => {
    expect(describePrismaError('x', { modelName: 'a b; c' })).toBe('Prisma query failed (arguments not logged)');
  });

  it('answers a fixed sentence for anything unreadable', () => {
    expect(describePrismaError(undefined, null)).toBe('Prisma query failed (arguments not logged)');
  });
});

describe('describeCaughtError', () => {
  it('is the message of an ordinary error, a string as it is, the type of anything else', () => {
    expect(describeCaughtError(new Error('Redis is down'))).toBe('Redis is down');
    expect(describeCaughtError('text')).toBe('text');
    expect(describeCaughtError(null)).toBe('Non-error value thrown (null)');
    expect(describeCaughtError({ a: 1 })).toBe('Non-error value thrown (object)');
  });

  it('describes a Prisma error and an SMTP error without their message', async () => {
    expect(describeCaughtError(await realValidationError())).toBe('user.update() failed (arguments not logged)');
    expect(describeCaughtError(smtpError())).toBe('EENVELOPE (SMTP 550)');
  });
});

describe('describeCaughtErrorWithStack', () => {
  it('is the label, the message and the frames of an error', () => {
    const error = Object.assign(new Error('boom'), { code: 'EFAIL' });
    const lines = describeCaughtErrorWithStack(error).split('\n');
    expect(lines[0]).toBe('Error [EFAIL]: boom');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => /^\s+at \S/.test(l))).toBe(true);
  });

  it('leaves the arguments of a Prisma call out of the line and of the frames', async () => {
    const text = describeCaughtErrorWithStack(await realValidationError());
    expect(text.split('\n')[0]).toBe('PrismaClientValidationError: user.update() failed (arguments not logged)');
    expect(text).not.toContain(SECRET_EMAIL);
    expect(text).not.toContain(SECRET_HASH);
  });

  it('a value that is not an error is one line', () => {
    expect(describeCaughtErrorWithStack('text')).toBe('Error: text');
    expect(describeCaughtErrorWithStack(null)).toBe('Error: Non-error value thrown (null)');
  });
});

import { describe, it, expect } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import {
  loggableError,
  describeCaughtError,
  describeCaughtErrorWithStack,
  describeStoreError,
  storeCall,
  errorLabel,
} from '../../utils/loggableError';
import { describeStoreError as describeStoreErrorFromS3 } from '../../utils/s3';

describe('an empty message', () => {
  it('falls back to the name and the string code, never an empty string', () => {
    expect(describeCaughtError(Object.assign(new Error(''), { code: 'ECONNREFUSED' }))).toBe('Error [ECONNREFUSED]');
    expect(describeCaughtError(new TypeError(''))).toBe('TypeError');
    expect(describeCaughtError('   ')).toBe('Error');
  });

  it('an AggregateError names its first three inner errors and counts the rest', () => {
    const inner = (code: string) => Object.assign(new Error(`connect ${code} 10.0.0.1:5432`), { code });
    const two = new AggregateError([inner('ECONNREFUSED'), inner('ETIMEDOUT')], '');
    expect(describeCaughtError(two)).toBe('AggregateError of Error [ECONNREFUSED], Error [ETIMEDOUT]');
    const five = new AggregateError([inner('A1'), inner('A2'), inner('A3'), inner('A4'), inner('A5')], '');
    expect(describeCaughtError(five)).toBe('AggregateError of Error [A1], Error [A2], Error [A3], and 2 more');
    expect(describeCaughtError(five)).not.toContain('10.0.0.1');
  });

  it('an AggregateError with a message keeps it, and the stack form carries the fallback too', () => {
    expect(describeCaughtError(new AggregateError([new Error('x')], 'several failed'))).toBe('several failed');
    const text = describeCaughtErrorWithStack(new AggregateError([Object.assign(new Error('x'), { code: 'EAI_AGAIN' })], ''));
    expect(text.split('\n')[0]).toBe('AggregateError: AggregateError of Error [EAI_AGAIN]');
  });
});

describe('a line break in the text', () => {
  it('is shown as two characters, so one error cannot write a second log line', () => {
    const text = describeCaughtError(new Error('first\nFAKE [Auth] line\r\nthird'));
    expect(text).toBe('first\\nFAKE [Auth] line\\r\\nthird');
    expect(text).not.toMatch(/[\r\n]/);
  });

  it('is shown the same in the stack form, whose frames stay on their own lines', () => {
    const lines = describeCaughtErrorWithStack(new Error('a\nb')).split('\n');
    expect(lines[0]).toBe('Error: a\\nb');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => /^\s+at \S/.test(l))).toBe(true);
  });

  it('a string thrown is escaped too', () => {
    expect(describeCaughtError('x\ny')).toBe('x\\ny');
  });
});

describe('the nodemailer shape', () => {
  it('an error whose command is not a string keeps its own message', () => {
    const err = Object.assign(new Error('the command object failed'), { command: { id: 7 }, code: 'E_JOB' });
    expect(loggableError(err).message).toBe('the command object failed');
    expect(describeCaughtError(err)).toBe('the command object failed');
  });

  it('a responseCode that is not a number is not an SMTP error either', () => {
    expect(loggableError(Object.assign(new Error('plain'), { responseCode: '550', code: 'E_PLAIN' })).message).toBe('plain');
  });

  it('a command string or a responseCode number still is one', () => {
    expect(loggableError(Object.assign(new Error('550 <a@b.c>'), { command: 'RCPT TO' })).message).toBe('SMTP error (RCPT TO)');
    expect(loggableError(Object.assign(new Error('550 <a@b.c>'), { responseCode: 550 })).message).toBe('SMTP 550');
  });
});

describe('an initialisation error', () => {
  it('is described by its name, never its message (which names the database host)', () => {
    const err = new Prisma.PrismaClientInitializationError("Can't reach database server at `db.internal.example:5432`", '7.0.0', 'P1001');
    const out = loggableError(err);
    expect(out.name).toBe('PrismaClientInitializationError');
    expect(out.message).toBe('Prisma client could not connect or initialise (message not logged)');
    expect(JSON.stringify(out)).not.toContain('db.internal.example');
    expect(describeCaughtError(err)).not.toContain('db.internal.example');
  });
});

describe('the frames of the stack form', () => {
  const frameLines = (text: string) => text.split('\n').slice(1);

  it('a message holding a frame-looking line does not forge a frame', () => {
    const err = new Error('m\n    at fake (x.js:1:1)');
    const lines = describeCaughtErrorWithStack(err).split('\n');
    expect(lines[0]).toBe('Error: m\\n    at fake (x.js:1:1)');
    expect(lines.join('\n')).not.toMatch(/\n\s+at fake/);
    expect(frameLines(describeCaughtErrorWithStack(err)).length).toBeGreaterThan(0);
  });

  it('a Prisma-like error whose message holds frame-looking lines keeps only the real frames', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Invalid `prisma.user.update()` invocation:\n    at forged (db.js:9:9)\nfailed', { code: 'P2025', clientVersion: '7.0.0' });
    expect(describeCaughtErrorWithStack(err)).not.toContain('forged');
    expect(loggableError(err).stack).not.toContain('forged');
  });

  it('a multi-line message without a frame-looking line leaves no message line among the frames', () => {
    const err = new Error('first\nsecond\nthird');
    const frames = frameLines(describeCaughtErrorWithStack(err));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((l) => /^\s+at \S/.test(l))).toBe(true);
    expect(frames.join('\n')).not.toMatch(/second|third/);
  });

  it('a stack that does not start with the message skips as many lines as the message has', () => {
    // the second header line looks like a frame: only the count of the message's lines keeps it out
    const err = Object.assign(new Error('a\n    at fake (x.js:1:1)'), {
      stack: 'custom header\n    at inTheHeader (z.js:1:1)\n    at real (y.js:2:2)',
    });
    expect(describeCaughtErrorWithStack(err).split('\n').slice(1)).toEqual(['    at real (y.js:2:2)']);
  });

  it('a frame line is written without its carriage return and with control characters escaped', () => {
    const esc = String.fromCharCode(0x1b);
    const err = Object.assign(new Error('m'), {
      stack: `Error: m\r\n    at one (a.js:1:1)\r\n    at two${esc}[31m (b.js:2:2)\r\n`,
    });
    expect(describeCaughtErrorWithStack(err).split('\n')).toEqual([
      'Error: m',
      '    at one (a.js:1:1)',
      '    at two\\u001b[31m (b.js:2:2)',
    ]);
    expect(loggableError(Object.assign(err, { responseCode: 550 })).stack).not.toContain(esc);
  });
});

describe('what can disturb a log line', () => {
  const kinds: Array<[string, number, string]> = [
    ['LF', 0x0a, '\\n'], ['CR', 0x0d, '\\r'], ['NEL', 0x85, '\\u0085'], ['LS', 0x2028, '\\u2028'],
    ['PS', 0x2029, '\\u2029'], ['vertical tab', 0x0b, '\\u000b'], ['form feed', 0x0c, '\\u000c'],
    ['escape', 0x1b, '\\u001b'], ['NUL', 0x00, '\\u0000'], ['backspace', 0x08, '\\u0008'], ['DEL', 0x7f, '\\u007f'],
  ];

  it.each(kinds)('%s in a message is shown as an escape', (_n, cp, shown) => {
    expect(describeCaughtError(new Error(`a${String.fromCharCode(cp)}b`))).toBe(`a${shown}b`);
  });

  it.each(kinds)('%s in a name and in a code is shown as an escape in the label', (_n, cp, shown) => {
    const ch = String.fromCharCode(cp);
    const err = Object.assign(new Error('m'), { name: `N${ch}x`, code: `C${ch}y` });
    expect(describeCaughtErrorWithStack(err).split('\n')[0]).toBe(`N${shown}x [C${shown}y]: m`);
    expect(errorLabel(err)).toBe(`N${shown}x [C${shown}y]`);
  });

  it('a name or a code longer than an identifier is cut, so the label stays a label', () => {
    const long = 'N'.repeat(300);
    const err = Object.assign(new Error('m'), { name: long, code: 'C'.repeat(300) });
    expect(errorLabel(err)).toBe(`${'N'.repeat(64)}... [${'C'.repeat(64)}...]`);
    expect(describeCaughtErrorWithStack(err).split('\n')[0]).toBe(`${'N'.repeat(64)}... [${'C'.repeat(64)}...]: m`);
  });

  it('a tab stays as it is', () => {
    expect(describeCaughtError(new Error('a\tb'))).toBe('a\tb');
  });

  it('the label of an empty-message fallback is escaped too', () => {
    const err = Object.assign(new Error(''), { name: `N${String.fromCharCode(0x2028)}`, code: 'C' });
    expect(describeCaughtError(err)).toBe('N\\u2028 [C]');
  });
});

describe('describeStoreError and storeCall', () => {
  it('storeCall keeps the original error as the cause', async () => {
    const original = Object.assign(new Error('secret store text'), { name: 'ServiceUnavailable' });
    const thrown = await storeCall(async () => { throw original; }).catch((e: unknown) => e as Error);
    expect(thrown.cause).toBe(original);
    expect(describeCaughtError(thrown)).not.toContain('secret store text');
  });

  it('describeStoreError reads the name, codes and HTTP status, never the message, and s3.ts re-exports it', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED store.example:9000 bucket my-bucket'), {
      name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 },
    });
    expect(describeStoreError(err)).toBe('ServiceUnavailable, HTTP 503');
    expect(describeStoreErrorFromS3).toBe(describeStoreError);
  });

  it('storeCall passes a result through and rethrows a failure as a described error', async () => {
    await expect(storeCall(async () => 5)).resolves.toBe(5);
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND store.example'), { name: 'ServiceUnavailable', code: 'ENOTFOUND' });
    const thrown = await storeCall(async () => { throw err; }).catch((e: unknown) => e as Error);
    expect(thrown.message).toBe('The object store call failed (ServiceUnavailable, ENOTFOUND)');
    expect(thrown.message).not.toContain('store.example');
  });
});

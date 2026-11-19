import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { clientLogLevels } from '../../utils/prisma';

// What the database client prints by itself (utils/prisma.ts). The REAL
// generated client is used: it refuses a malformed call before any connection
// is made, so no database is needed, and the test sees what the client really
// writes for it.

const SECRET_EMAIL = 'someone.private@example.org';
const SECRET_HASH = '$2a$12$abcdefghijklmnopqrstuuvwxyz0123456789ABCDEFGHIJKLMNO';

/** Everything written to the console or the two streams while `run` runs. */
async function printedDuring(run: () => Promise<unknown>): Promise<string> {
  const printed: string[] = [];
  const note = (...parts: unknown[]) => { printed.push(parts.map(String).join(' ')); };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(note),
    vi.spyOn(console, 'info').mockImplementation(note),
    vi.spyOn(console, 'warn').mockImplementation(note),
    vi.spyOn(console, 'error').mockImplementation(note),
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { note(chunk); return true; }) as never),
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { note(chunk); return true; }) as never),
  ];
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return printed.join('\n');
}

/** A call the client refuses as malformed, with private values among its arguments. */
async function malformedCall(log: Array<'warn' | 'error'>): Promise<{ thrown: unknown; printed: string }> {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/none' }),
    log,
  });
  let thrown: unknown;
  const printed = await printedDuring(async () => {
    try {
      await client.user.update({
        where: { email: SECRET_EMAIL },
        data: { password: SECRET_HASH, notAColumn: true } as never,
      });
    } catch (err) {
      thrown = err;
    } finally {
      await client.$disconnect();
    }
  });
  return { thrown, printed };
}

describe('clientLogLevels', () => {
  it('is empty for production, for a test run, for any other value and for no value', () => {
    for (const env of ['production', 'test', 'staging', 'Development', 'DEVELOPMENT', ' development', '', undefined]) {
      expect(clientLogLevels(env), String(env)).toEqual([]);
    }
  });

  it('keeps both levels for exactly "development"', () => {
    expect(clientLogLevels('development')).toEqual(['warn', 'error']);
  });
});

describe('what the database client prints by itself', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('the control: at its error level the client prints the arguments of a malformed call', async () => {
    const { thrown, printed } = await malformedCall(['error']);

    expect((thrown as Error).name).toBe('PrismaClientValidationError');
    // this is what the setting keeps out of the log; if a later client stops
    // printing it, this control says so and the setting can be looked at again
    expect(printed).toContain(SECRET_EMAIL);
    expect(printed).toContain(SECRET_HASH);
  });

  it('with the levels of production the same call prints nothing and is still thrown', async () => {
    const { thrown, printed } = await malformedCall(clientLogLevels('production'));

    expect((thrown as Error).name).toBe('PrismaClientValidationError');
    expect(printed).toBe('');
  });

  it('with no NODE_ENV at all it prints nothing either', async () => {
    const { thrown, printed } = await malformedCall(clientLogLevels(undefined));

    expect((thrown as Error).name).toBe('PrismaClientValidationError');
    expect(printed).toBe('');
  });
});

describe('utils/prisma.ts', () => {
  const source = readFileSync(path.resolve(__dirname, '../../utils/prisma.ts'), 'utf8');

  it('builds the one client with the levels of clientLogLevels(NODE_ENV), and names no level anywhere else', () => {
    expect(source.match(/new PrismaClient\(/g)).toHaveLength(1);
    expect(source).toContain('log: clientLogLevels(process.env.NODE_ENV),');
    expect(source.match(/\blog:/g)).toHaveLength(1);
    // the only place a level is written is the function's one line
    expect(source.match(/\[[^\]]*'error'[^\]]*\]/g)).toEqual(["['warn', 'error']"]);
  });
});

import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * What the client prints BY ITSELF: nothing, outside development.
 *
 * At its `error` level the client writes a `prisma:error` line for every
 * statement that fails, before it throws. That line holds the arguments of a
 * call the client refuses as malformed (an e-mail address, a password hash)
 * and the value a failed raw statement quotes. Every failure is thrown as
 * well, and the error handler logs what reaches it by name, code, operation
 * and model, without the arguments (middleware/errorHandler.ts): the client's
 * line put those arguments back into the log, and added one line for each
 * refusal a route answers itself (a duplicate, a row gone meanwhile). A
 * developer's own terminal keeps both levels. Any other value of NODE_ENV,
 * and none at all, prints nothing.
 */
export function clientLogLevels(nodeEnv: string | undefined): Array<'warn' | 'error'> {
  return nodeEnv === 'development' ? ['warn', 'error'] : [];
}

// Use a factory function to avoid creating the adapter at import time.
// ES module imports are hoisted — if prisma.ts is imported before dotenv.config()
// runs, process.env.DATABASE_URL would be undefined at module scope.
// The Proxy ensures the PrismaClient is only created on first property access
// (which always happens after dotenv has loaded in index.ts's main()).
let _prisma: PrismaClient | null = null;

function getPrismaClient(): PrismaClient {
  if (!_prisma) {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    _prisma = new PrismaClient({
      adapter,
      log: clientLogLevels(process.env.NODE_ENV),
    });
  }
  return _prisma;
}

// Export a proxy that lazily initializes the PrismaClient on first use
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return (getPrismaClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

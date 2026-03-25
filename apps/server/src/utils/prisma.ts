import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

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
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
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

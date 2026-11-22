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

/** node-postgres's own pool size, and what an unset or invalid setting reads as. */
export const DEFAULT_DATABASE_POOL_MAX = 10;
/** The largest pool size `DATABASE_POOL_MAX` may name. */
export const MAX_DATABASE_POOL_MAX = 1000;
/** The largest value of `DATABASE_POOL_IDLE_TIMEOUT_MS` (one hour). */
export const MAX_DATABASE_POOL_IDLE_TIMEOUT_MS = 3_600_000;
/** The largest value of `DATABASE_POOL_CONNECTION_TIMEOUT_MS` (ten minutes). */
export const MAX_DATABASE_POOL_CONNECTION_TIMEOUT_MS = 600_000;

/**
 * One whole-number pool setting: digits only, between `min` and `max`. Unset or
 * empty is `undefined` without a warning; any other value that is not such a
 * number is `undefined` with one warning naming the setting and the rule, never
 * the value (a value pasted into the wrong setting can be a secret).
 */
function readPoolSetting(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  const n = /^\d{1,8}$/.test(text) ? Number(text) : NaN;
  if (n >= min && n <= max) return n;
  console.warn(`[Prisma] Ignoring ${name} (want a whole number ${min}-${max}); using the default`);
  return undefined;
}

/**
 * The most connections this process's pool opens at once: `DATABASE_POOL_MAX`,
 * a whole number from 1 to MAX_DATABASE_POOL_MAX. The adapter hands its
 * options to `new pg.Pool(...)`, which reads the size from `max` alone (a
 * parameter in DATABASE_URL never sets it). Unset or empty reads the default;
 * any other value reads the default too, with a warning naming the setting.
 */
export function databasePoolMax(raw: string | undefined): number {
  return readPoolSetting('DATABASE_POOL_MAX', raw, 1, MAX_DATABASE_POOL_MAX) ?? DEFAULT_DATABASE_POOL_MAX;
}

/**
 * `DATABASE_POOL_IDLE_TIMEOUT_MS` (pg's `idleTimeoutMillis`): how long an idle
 * connection stays open, 0 to MAX_DATABASE_POOL_IDLE_TIMEOUT_MS, 0 meaning
 * never closed. `undefined` (unset, empty or unusable) passes nothing, so the
 * pool keeps its own default.
 */
export function databasePoolIdleTimeoutMs(raw: string | undefined): number | undefined {
  return readPoolSetting('DATABASE_POOL_IDLE_TIMEOUT_MS', raw, 0, MAX_DATABASE_POOL_IDLE_TIMEOUT_MS);
}

/**
 * `DATABASE_POOL_CONNECTION_TIMEOUT_MS` (pg's `connectionTimeoutMillis`): how
 * long a request waits for a connection, 0 to MAX_DATABASE_POOL_CONNECTION_TIMEOUT_MS,
 * 0 meaning no limit. `undefined` passes nothing, so the pool keeps its own
 * default.
 */
export function databasePoolConnectionTimeoutMs(raw: string | undefined): number | undefined {
  return readPoolSetting('DATABASE_POOL_CONNECTION_TIMEOUT_MS', raw, 0, MAX_DATABASE_POOL_CONNECTION_TIMEOUT_MS);
}

/** The options handed to the driver adapter; an unset timeout is left out. */
export function databasePoolOptions(env: NodeJS.ProcessEnv): {
  connectionString: string;
  max: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
} {
  const idle = databasePoolIdleTimeoutMs(env.DATABASE_POOL_IDLE_TIMEOUT_MS);
  const connect = databasePoolConnectionTimeoutMs(env.DATABASE_POOL_CONNECTION_TIMEOUT_MS);
  return {
    connectionString: env.DATABASE_URL!,
    max: databasePoolMax(env.DATABASE_POOL_MAX),
    ...(idle !== undefined ? { idleTimeoutMillis: idle } : {}),
    ...(connect !== undefined ? { connectionTimeoutMillis: connect } : {}),
  };
}

// Use a factory function to avoid creating the adapter at import time.
// ES module imports are hoisted — if prisma.ts is imported before dotenv.config()
// runs, process.env.DATABASE_URL would be undefined at module scope.
// The Proxy ensures the PrismaClient is only created on first property access
// (which always happens after dotenv has loaded in index.ts's main()).
let _prisma: PrismaClient | null = null;

function getPrismaClient(): PrismaClient {
  if (!_prisma) {
    const adapter = new PrismaPg(databasePoolOptions(process.env));
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

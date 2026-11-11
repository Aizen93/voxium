/**
 * A bounded retry of a whole transaction that PostgreSQL aborted to break a
 * deadlock (SQLSTATE 40P01) or a serialization failure (40001).
 *
 * It is a net, not the design: the transactions that use it take their row
 * locks in one documented order, and this covers an order nobody foresaw.
 * Retried: Prisma's P2034 (a model statement's write conflict or deadlock),
 * and P2010 / P2039 (a raw statement's database error) only when the driver
 * reports one of those two SQLSTATEs. Never anything else: a refusal, a
 * constraint violation or a timeout is the answer, and the work must not run
 * twice for it. The callback must be the WHOLE transaction (an aborted one is
 * rolled back entirely, so running it again is safe) and must have no side
 * effect outside it.
 */

/** Retries after the first attempt. */
export const TRANSACTION_CONFLICT_RETRIES = 2;

/** The pause before a retry: a jittered few tens of milliseconds, so two losers do not meet again. */
const RETRY_PAUSE_MIN_MS = 25;
const RETRY_PAUSE_SPREAD_MS = 75;

const CONFLICT_SQLSTATES = new Set(['40P01', '40001']);

/** True for a deadlock or a serialization failure, as Prisma surfaces them. */
export function isTransactionConflict(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    message?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code === 'P2034') return true;
  if (e.code !== 'P2010' && e.code !== 'P2039') return false;
  const sqlState = e.meta?.driverAdapterError?.cause?.originalCode;
  if (typeof sqlState === 'string') return CONFLICT_SQLSTATES.has(sqlState);
  // The driver error is not always attached: the message carries the code
  const fromMessage = typeof e.message === 'string' ? /Code: `(\w{5})`/.exec(e.message)?.[1] : undefined;
  return fromMessage !== undefined && CONFLICT_SQLSTATES.has(fromMessage);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `transaction`, and run it again (at most TRANSACTION_CONFLICT_RETRIES
 * more times) when PostgreSQL aborted it as a deadlock or serialization
 * victim. Any other error, or a conflict on the last attempt, is thrown.
 */
export async function retryOnTransactionConflict<T>(
  transaction: () => Promise<T>,
  label: string,
  opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = opts.retries ?? TRANSACTION_CONFLICT_RETRIES;
  const sleep = opts.sleep ?? pause;
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction();
    } catch (err) {
      if (attempt >= retries || !isTransactionConflict(err)) throw err;
      console.warn(`${label} was aborted by a deadlock or a serialization failure; retrying (${attempt + 1} of ${retries})`);
      await sleep(RETRY_PAUSE_MIN_MS + Math.random() * RETRY_PAUSE_SPREAD_MS);
    }
  }
}

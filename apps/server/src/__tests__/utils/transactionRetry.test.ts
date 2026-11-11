import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTransactionConflict, retryOnTransactionConflict, TRANSACTION_CONFLICT_RETRIES } from '../../utils/transactionRetry';

// The net under the documented lock orders: a whole transaction PostgreSQL
// aborted to break a deadlock (40P01) or a serialization failure (40001) is
// run again, twice at most, and nothing else ever is.

const raw = (sqlState: string, withMeta = true) => Object.assign(
  new Error(`Raw query failed. Code: \`${sqlState}\`. Message: \`...\``),
  { code: 'P2010', ...(withMeta && { meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode: sqlState } } } }) },
);

describe('isTransactionConflict', () => {
  it('is true for a model statement\'s write conflict or deadlock (P2034)', () => {
    expect(isTransactionConflict(Object.assign(new Error('write conflict'), { code: 'P2034' }))).toBe(true);
  });

  it('is true for a raw statement\'s deadlock or serialization failure, from the driver error or the message', () => {
    expect(isTransactionConflict(raw('40P01'))).toBe(true);
    expect(isTransactionConflict(raw('40001'))).toBe(true);
    expect(isTransactionConflict(raw('40P01', false))).toBe(true);
    expect(isTransactionConflict(Object.assign(raw('40P01'), { code: 'P2039' }))).toBe(true);
  });

  it('is false for everything else: another SQLSTATE, a refusal, a missing row, a timeout, a plain error', () => {
    expect(isTransactionConflict(raw('23503'))).toBe(false);
    expect(isTransactionConflict(raw('57014', false))).toBe(false);
    expect(isTransactionConflict(Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }))).toBe(false);
    expect(isTransactionConflict(Object.assign(new Error('Transaction already closed'), { code: 'P2028' }))).toBe(false);
    expect(isTransactionConflict(new Error('Code: `40P01`'))).toBe(false);
    expect(isTransactionConflict(null)).toBe(false);
    expect(isTransactionConflict('40P01')).toBe(false);
  });
});

describe('retryOnTransactionConflict', () => {
  const sleep = vi.fn(async () => {});
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    sleep.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); });

  it('answers the first attempt that commits', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(raw('40P01'))
      .mockResolvedValueOnce('done');

    await expect(retryOnTransactionConflict(run, '[T] The thing', { sleep })).resolves.toBe('done');

    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[T] The thing was aborted by a deadlock or a serialization failure; retrying (1 of 2)');
    // a short jittered pause before the retry, never none
    const [ms] = sleep.mock.calls[0] as unknown as [number];
    expect(ms).toBeGreaterThanOrEqual(25);
    expect(ms).toBeLessThan(100);
  });

  it('runs at most TRANSACTION_CONFLICT_RETRIES more times, then throws the last conflict', async () => {
    expect(TRANSACTION_CONFLICT_RETRIES).toBe(2);
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('deadlock'), { code: 'P2034' }));

    await expect(retryOnTransactionConflict(run, '[T] The thing', { sleep })).rejects.toMatchObject({ code: 'P2034' });

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never retries any other error', async () => {
    const missing = Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
    const run = vi.fn().mockRejectedValue(missing);

    await expect(retryOnTransactionConflict(run, '[T] The thing', { sleep })).rejects.toBe(missing);

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

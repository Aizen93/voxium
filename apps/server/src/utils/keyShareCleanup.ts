import { prisma } from './prisma';
import { E2E_LIMITS } from '@voxium/shared';
import { withClusterLock, wasSkipped } from './dailySchedule';

// Sweeps undeliverable E2E key shares (docs/e2e-dm-spec.md §12) and stale
// master-secret transfers (§14).
//
// Key shares are claim-and-delete. Master transfers are read-then-ack (§14.4:
// a read that consumed the row would strand a device that fails mid-claim), so
// this sweep is their only automatic reclaimer when the ack itself never
// arrives. Rows that are never cleared — a device that never comes back, or an
// account that was deleted (neither table has an FK to User, so nothing
// cascades) — would otherwise live forever, holding routing metadata (who
// key-shared or device-approved with whom, when) long past its use.

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// Every node fires this interval; the deletes are idempotent, so the cost of
// running it N times was N identical scans — but a job that runs once per
// node is a job whose logs lie about what happened. Leader-locked like the
// other sweeps.
export const KEYSHARE_SWEEP_LOCK_KEY = 'lock:keysharecleanup';
export const KEYSHARE_SWEEP_LOCK_TTL_SECONDS = 10 * 60;

export function startKeyShareCleanup(): void {
  if (!stopped) return;
  stopped = false;
  scheduleNext(SWEEP_INTERVAL_MS);
}

export function stopKeyShareCleanup(): void {
  stopped = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function scheduleNext(delay: number): void {
  if (stopped) return;
  timeoutId = setTimeout(runSweep, delay);
  // Never hold the process open just for a cleanup timer
  timeoutId.unref?.();
}

/** Rows swept, or 0 when another node holds the lock / the sweep failed. Always re-arms the timer. */
export async function runSweep(): Promise<number> {
  try {
    const result = await withClusterLock(
      { key: KEYSHARE_SWEEP_LOCK_KEY, ttlSeconds: KEYSHARE_SWEEP_LOCK_TTL_SECONDS, tag: '[E2E]' },
      sweepStaleRows,
    );
    return wasSkipped(result) ? 0 : result;
  } catch (err) {
    console.error('[E2E] Key-share sweep failed:', err instanceof Error ? err.message : err);
    return 0;
  } finally {
    scheduleNext(SWEEP_INTERVAL_MS);
  }
}

async function sweepStaleRows(): Promise<number> {
  const cutoff = new Date(Date.now() - E2E_LIMITS.KEYSHARE_MAX_AGE_MS);
  const { count } = await prisma.e2EKeyShare.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) console.log(`[E2E] Swept ${count} stale key share(s)`);
  // Device approval is an interactive, minutes-long flow: anything this old
  // is an abandoned handshake, and its Olm body is undecryptable anyway.
  const transfers = await prisma.e2EMasterTransfer.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (transfers.count > 0) console.log(`[E2E] Swept ${transfers.count} stale master transfer(s)`);
  return count + transfers.count;
}

import { prisma } from './prisma';
import { E2E_LIMITS } from '@voxium/shared';

// Sweeps undeliverable E2E key shares (docs/e2e-dm-spec.md §12) and stale
// master-secret transfers (§14).
//
// Both are normally claim-and-delete: a device drains its inbox and the rows
// disappear. Rows that are never claimed — a device that never comes back, or
// an account that was deleted (neither table has an FK to User, so nothing
// cascades) — would otherwise live forever, holding routing metadata (who
// key-shared or device-approved with whom, when) long past its use.

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

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

export async function runSweep(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - E2E_LIMITS.KEYSHARE_MAX_AGE_MS);
    const { count } = await prisma.e2EKeyShare.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (count > 0) console.log(`[E2E] Swept ${count} stale key share(s)`);
    // Device approval is an interactive, minutes-long flow: anything this old
    // is an abandoned handshake, and its Olm body is undecryptable anyway.
    const transfers = await prisma.e2EMasterTransfer.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (transfers.count > 0) console.log(`[E2E] Swept ${transfers.count} stale master transfer(s)`);
    return count + transfers.count;
  } catch (err) {
    console.error('[E2E] Key-share sweep failed:', err instanceof Error ? err.message : err);
    return 0;
  } finally {
    scheduleNext(SWEEP_INTERVAL_MS);
  }
}

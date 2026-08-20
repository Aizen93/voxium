// Registration proof-of-work: run the solve in a worker, fall back in place.
//
// The solve is 1M expected SHA-256 digests at the issued ceiling — tens of
// seconds. A worker keeps the page interactive and lets us report progress;
// the in-thread fallback exists because `Worker` construction can fail for
// reasons we do not control (a hardened CSP, a bundler edge, an embedded
// webview), and a slower registration beats a broken one.
import { solveRegistrationPow, PowExpiredError, type PowChallenge, type PowSolution } from '@voxium/shared';
import type { PowWorkerOut } from '../workers/registrationPow.worker';

/** Progress fraction in [0, 1]. The distribution is geometric, so a solve can
 *  legitimately run past its expected attempt count — the value is CLAMPED
 *  rather than allowed past 1, and a bar that parks near the end is honest
 *  about "any moment now" in a way a jumping-back one is not. */
export type PowProgress = (fraction: number) => void;

/**
 * Solve `challenge`, reporting progress. Rejects with the solver's own error
 * (including `PowExpiredError`) so callers can distinguish "refetch and retry"
 * from a hard failure.
 */
export async function solveRegistrationPowOffThread(
  challenge: PowChallenge,
  onProgress?: PowProgress,
): Promise<PowSolution> {
  const worker = spawnWorker();
  if (!worker) {
    // No worker: still solve, just without progress or a free main thread.
    return solveRegistrationPow(challenge);
  }

  try {
    return await new Promise<PowSolution>((resolve, reject) => {
      worker.addEventListener('message', (event: MessageEvent) => {
        const msg = event.data as PowWorkerOut;
        if (msg.op === 'progress') {
          onProgress?.(Math.min(1, msg.attempts / Math.max(1, msg.expected)));
        } else if (msg.op === 'solved') {
          resolve(msg.solution);
        } else if (msg.op === 'error') {
          // Rebuild the class across the worker boundary — the caller retries
          // with a fresh challenge on expiry and gives up on anything else.
          reject(msg.expired ? new PowExpiredError() : new Error(msg.message));
        }
      });
      // A worker that dies mid-solve (OOM, crashed renderer) would otherwise
      // leave the registration promise pending forever behind a spinner.
      worker.addEventListener('error', (event) => {
        reject(new Error(event.message || 'Proof-of-work worker failed'));
      });
      worker.postMessage({ op: 'solve', challenge });
    });
  } finally {
    worker.terminate();
  }
}

function spawnWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    // Same-origin bundled worker (Vite `new URL` pattern) — satisfies the
    // Tauri CSP, which has no worker-src carve-out for blob: workers.
    return new Worker(new URL('../workers/registrationPow.worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch (err) {
    console.warn('[PoW] Worker unavailable, solving on the main thread:', err);
    return null;
  }
}

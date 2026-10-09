// Registration proof-of-work: run the solve in a worker, fall back in place.
//
// The solve is 1M expected SHA-256 digests at the issued ceiling — tens of
// seconds. A worker keeps the page interactive and lets us report progress;
// the in-thread fallback exists because `Worker` construction can fail for
// reasons we do not control (a hardened CSP, a bundler edge, an embedded
// webview), and a slower registration beats a broken one.
import { solveRegistrationPow, PowExpiredError, PowAbortedError, type PowChallenge, type PowSolution } from '@voxium/shared';
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
  signal?: AbortSignal,
): Promise<PowSolution> {
  if (signal?.aborted) throw new PowAbortedError();
  const worker = spawnWorker();
  if (!worker) {
    // No worker: still solve, just without a free main thread. The signal still
    // applies — the in-thread loop checks it at its deadline cadence.
    return solveRegistrationPow(challenge, { signal });
  }

  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<PowSolution>((resolve, reject) => {
      // Whether the worker has ever spoken — see the `error` handler below.
      let workerSpoke = false;
      worker.addEventListener('message', (event: MessageEvent) => {
        workerSpoke = true;
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
      // A worker `error` arrives for two very different reasons and only one is
      // fatal. If the module never LOADED — a hashed chunk missing after a
      // redeploy, a filtering proxy, a content blocker — construction still
      // SUCCEEDED, so `spawnWorker`'s try/catch never saw it and the failure
      // shows up here instead, asynchronously. Rejecting on that would make
      // registration impossible on that browser while the identical solver runs
      // fine in-thread. So: an error before the worker has said anything falls
      // back; one after a real solve started is fatal (OOM, crashed renderer),
      // and rejecting is what keeps the promise from hanging behind a spinner.
      worker.addEventListener('error', (event) => {
        if (!workerSpoke) {
          console.warn('[PoW] Worker never started, solving on the main thread:', event.message || 'unknown error');
          solveRegistrationPow(challenge, { signal }).then(resolve, reject);
          return;
        }
        reject(new Error(event.message || 'Proof-of-work worker failed'));
      });
      if (signal) {
        onAbort = () => reject(new PowAbortedError());
        signal.addEventListener('abort', onAbort, { once: true });
      }
      worker.postMessage({ op: 'solve', challenge });
    });
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
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

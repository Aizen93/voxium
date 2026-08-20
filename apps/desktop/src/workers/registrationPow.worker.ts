/// <reference lib="webworker" />
// Registration proof-of-work solver, off the main thread.
//
// The solve is a tight WebCrypto loop that can run for tens of seconds at the
// issued difficulty ceiling. On the main thread that starves rAF and input
// handling for the whole duration with nothing on screen but a disabled
// button; here it costs the UI nothing and the page stays interactive while
// progress ticks in.
//
// The solver itself lives in @voxium/shared so the Playwright helpers and the
// load scripts run the exact same code path under Node — this file is only the
// message shell.
import { solveRegistrationPow, PowExpiredError, type PowChallenge, type PowSolution } from '@voxium/shared';

type SolveMsg = { op: 'solve'; challenge: PowChallenge };

export type PowWorkerOut =
  | { op: 'progress'; attempts: number; expected: number }
  | { op: 'solved'; solution: PowSolution }
  | { op: 'error'; message: string; expired: boolean };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as SolveMsg;
  if (msg?.op !== 'solve') return;

  solveRegistrationPow(msg.challenge, {
    onProgress: (attempts, expected) => {
      const out: PowWorkerOut = { op: 'progress', attempts, expected };
      ctx.postMessage(out);
    },
  })
    .then((solution) => {
      const out: PowWorkerOut = { op: 'solved', solution };
      ctx.postMessage(out);
    })
    .catch((err: unknown) => {
      const out: PowWorkerOut = {
        op: 'error',
        message: err instanceof Error ? err.message : String(err),
        expired: err instanceof PowExpiredError,
      };
      ctx.postMessage(out);
    });
});

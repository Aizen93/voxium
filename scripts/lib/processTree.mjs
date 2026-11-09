// Stop a spawned child AND every process it started, for the dev scripts
// (scripts/dev-all.mjs, scripts/test-multi-node.ts, any later one).
//
// Windows has no POSIX signals: `child.kill()` is TerminateProcess on that ONE
// pid, and its children live on. Our scripts spawn through wrappers (cmd.exe,
// pnpm, tsx, cargo), so the pid we hold is rarely the process holding the
// port. The survivor is then wedged as well as orphaned: on Windows a write to
// a pipe is synchronous (Node, "A note on process I/O"), so with its parent
// gone nobody reads its stdout and its next log line blocks it forever, port
// still bound, /health never answering. `taskkill /T` walks the tree by parent
// pid, `/F` terminates it: the only reliable stop there.
//
// POSIX keeps what these scripts always did, `child.kill(signal)`: there the
// signal reaches a wrapper that forwards it (or the process itself, when it is
// spawned without one), Ctrl-C reaches the whole foreground process group
// anyway, and a pipe write is asynchronous, so a survivor cannot wedge on it.
//
// No top-level await here: the .ts scripts load this file through require(esm).

import { spawn as nodeSpawn } from 'node:child_process';

/** taskkill's exit code when the pid is gone already (the tree died first). */
export const TASKKILL_NOT_FOUND = 128;

/**
 * Kill `child` and, on Windows, its whole process tree.
 *
 * Never kills a pid whose process this script has seen exit: Windows reuses
 * pids, and `taskkill /T` on a recycled one would take an unrelated tree.
 * Never rejects; a failure is logged and the promise still resolves.
 *
 * @param {{ pid?: number, exitCode: number | null, signalCode: NodeJS.Signals | null, kill(signal?: NodeJS.Signals): boolean }} child
 * @param {{ signal?: NodeJS.Signals, platform?: NodeJS.Platform, spawn?: typeof nodeSpawn }} [options]
 *   `signal` is used on POSIX only (taskkill /F has no gentler form);
 *   `platform` and `spawn` exist for the tests.
 * @returns {Promise<void>} resolves once taskkill has finished (Windows) or the signal is sent (POSIX)
 */
export function killProcessTree(child, { signal = 'SIGTERM', platform = process.platform, spawn = nodeSpawn } = {}) {
  if (!child || child.pid === undefined) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  if (platform !== 'win32') {
    try {
      child.kill(signal);
    } catch (err) {
      console.warn(`[processTree] could not signal pid ${child.pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return Promise.resolve();
  }

  const pid = child.pid;
  return new Promise((resolve) => {
    let killer;
    try {
      // An args array and no shell: nothing here is interpreted by cmd.exe
      killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      console.warn(`[processTree] could not start taskkill for pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    killer.on('error', (err) => {
      console.warn(`[processTree] taskkill for pid ${pid} failed: ${err.message}`);
      done();
    });
    killer.on('close', (code) => {
      if (code !== 0 && code !== TASKKILL_NOT_FOUND && code !== null) {
        console.warn(`[processTree] taskkill for pid ${pid} exited with ${code}`);
      }
      done();
    });
  });
}

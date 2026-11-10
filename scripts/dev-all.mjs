#!/usr/bin/env node
// Bring up the whole stack with one command.
//
// THREE processes, not four: `tauri dev` runs its own `beforeDevCommand`
// (`pnpm dev` inside apps/desktop), which is the Vite server on 8080. Starting
// @voxium/desktop's dev script here as well would put two Vite servers on the
// same port — the second picks a random one, and Tauri's devUrl still points at
// 8080, so the app would load whichever won the race.
//
// Tauri is treated as optional: it needs the Rust toolchain and compiles on
// first run, so a machine without it still gets the backend, the browser client
// and the admin dashboard rather than a failed command.
//
// Stopping on Windows: each child is a cmd.exe wrapper over pnpm, tsx, vite or
// cargo, and `child.kill()` would end that wrapper alone, leaving the server
// holding its port (scripts/lib/processTree.mjs). Shutdown kills the tree of
// every child still running.

import { spawn } from 'node:child_process';
import { killProcessTree } from './lib/processTree.mjs';

const IS_WINDOWS = process.platform === 'win32';
// A Ctrl-C or Ctrl-Break on Windows reaches every process on the console, and
// the pnpm / tsx chains tear themselves down: pnpm and `tsx watch` answer it by
// ending their own child (a kill there is TerminateProcess), so the backend
// stops within milliseconds, not through its shutdown handler, and the cmd.exe
// wrapper held here exits soon after. The grace only waits for that; taskkill
// is the fallback for any tree still alive after it. When a required child
// failed, or on SIGTERM, nothing else is stopping the others: their trees are
// killed at once.
const CTRL_C_GRACE_MS = 5000;

const TARGETS = [
  { name: 'server', args: ['--filter', '@voxium/server', 'dev'], colour: '[36m' },
  { name: 'admin', args: ['--filter', '@voxium/admin', 'dev'], colour: '[35m' },
  {
    name: 'tauri',
    args: ['--filter', '@voxium/desktop', 'tauri:dev'],
    colour: '[33m',
    optional: true,
    hint: 'needs the Rust toolchain — https://tauri.app/start/prerequisites/. The browser client is still on http://localhost:8080',
  },
];

const RESET = '[0m';
const DIM = '[2m';

if (process.argv.includes('--dry-run')) {
  for (const t of TARGETS) console.log(`${t.name}: pnpm ${t.args.join(' ')}${t.optional ? ' (optional)' : ''}`);
  process.exit(0);
}

const children = [];
let shuttingDown = false;

/** Prefix every line so three interleaved logs stay readable. */
function pipe(stream, target, isError) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const out = isError ? process.stderr : process.stdout;
      out.write(`${target.colour}[${target.name}]${RESET} ${line}\n`);
    }
  });
}

for (const target of TARGETS) {
  // shell: true because `pnpm` is a .cmd shim on Windows. The command is ONE string
  // built from the constants above (never from input): passing an argument array
  // together with shell: true is deprecated (DEP0190), the arguments are not escaped.
  const child = spawn(`pnpm ${target.args.join(' ')}`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  pipe(child.stdout, target, false);
  pipe(child.stderr, target, true);
  children.push(child);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    if (code === 0) {
      console.log(`${DIM}[${target.name}] exited${RESET}`);
      return;
    }
    if (target.optional) {
      // Loud but not fatal: losing the desktop shell should not take down a
      // working backend that other people are pointing a browser at.
      console.error(`${target.colour}[${target.name}]${RESET} did not start (exit ${code}) — ${target.hint}`);
      return;
    }
    console.error(`${target.colour}[${target.name}]${RESET} exited with ${code}; shutting the rest down`);
    shutdown(code ?? 1);
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true once the child exits, false after `ms`. */
function waitForExit(child, ms) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, ms);
    child.once('exit', onExit);
  });
}

/** Windows: wait out the grace (after a Ctrl-C the chain is tearing itself
 *  down), then kill the child's tree if it is still running. */
async function stopTree(child, target, graceMs) {
  if (graceMs > 0 && (await waitForExit(child, graceMs))) return;
  if (graceMs > 0) console.log(`${DIM}[${target.name}] still running after ${graceMs / 1000} s; killing its process tree${RESET}`);
  await killProcessTree(child);
}

/** `fromConsole`: a Ctrl-C / Ctrl-Break, which Windows also delivered to the children. */
function shutdown(code, { fromConsole = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!IS_WINDOWS) {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    // Give children a moment to go quietly before the parent does.
    setTimeout(() => process.exit(code), 300).unref();
    return;
  }
  const graceMs = fromConsole ? CTRL_C_GRACE_MS : 0;
  Promise.all(children.map((child, i) => stopTree(child, TARGETS[i], graceMs))).then(
    () => process.exit(code),
    (err) => {
      console.error(`could not stop every process: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(code || 1);
    },
  );
}

process.on('SIGINT', () => shutdown(0, { fromConsole: true }));
process.on('SIGTERM', () => shutdown(0));
if (IS_WINDOWS) process.on('SIGBREAK', () => shutdown(0, { fromConsole: true }));

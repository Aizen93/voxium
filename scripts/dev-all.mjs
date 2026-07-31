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

import { spawn } from 'node:child_process';

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
  // shell: true because `pnpm` is a .cmd shim on Windows.
  const child = spawn('pnpm', target.args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  // Give children a moment to go quietly before the parent does.
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

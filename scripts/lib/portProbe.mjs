// Is a TCP port already taken, before a script starts a server on it?
// (scripts/test-multi-node.ts: a dev backend on 3001 would answer /health
// for a node that never started.)
//
// Each host is probed with a bind of its own. No single probe sees every
// listener: on Windows a bind on 0.0.0.0 or :: succeeds next to a listener on
// 127.0.0.1 or ::1, and the two wildcards succeed next to each other
// (measured with Node 26 on Windows 11). The four hosts cover where the
// servers bind (0.0.0.0) and where `http://localhost:<port>` can land.
//
// No top-level await here: the .ts scripts load this file through require(esm).

import net from 'node:net';

export const PROBE_HOSTS = ['0.0.0.0', '::', '127.0.0.1', '::1'];

/** A bind on an IPv6 host fails this way when the machine has no IPv6: nothing can listen there. */
const NO_SUCH_ADDRESS = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

/**
 * Try to listen on `host:port`, then close at once.
 *
 * @param {number} port
 * @param {string} host
 * @returns {Promise<{ state: 'free' } | { state: 'in-use' } | { state: 'error', code: string | undefined, message: string }>}
 */
export function probeBind(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve({ state: 'in-use' });
      else resolve({ state: 'error', code: err.code, message: err.message });
    });
    probe.once('listening', () => probe.close(() => resolve({ state: 'free' })));
    probe.listen(port, host);
  });
}

/**
 * Why `port` cannot be used, or null when it is free on every probed host.
 * An IPv6 host the machine does not have is skipped; any other bind error
 * (EACCES, an IPv4 address missing) is reported as itself, never as "in use".
 *
 * @param {number} port
 * @param {{ hosts?: readonly string[], probe?: typeof probeBind }} [options] `probe` exists for the tests
 * @returns {Promise<string | null>}
 */
export async function portProblem(port, { hosts = PROBE_HOSTS, probe = probeBind } = {}) {
  for (const host of hosts) {
    const result = await probe(port, host);
    if (result.state === 'in-use') return `something already listens on ${host}:${port}`;
    if (result.state === 'error') {
      if (host.includes(':') && result.code && NO_SUCH_ADDRESS.has(result.code)) continue;
      return `cannot bind ${host}:${port} to check it (${result.code ?? result.message})`;
    }
  }
  return null;
}

import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import { PROBE_HOSTS, portProblem, probeBind } from '../../../../../scripts/lib/portProbe.mjs';

// The pre-flight port check of scripts/test-multi-node.ts (beside
// processTree.test.ts: the root scripts' helpers are tested in this suite).
// Real sockets on ephemeral ports only: never 3001/3002, which a dev backend
// or another run may hold.

const NO_SUCH_ADDRESS = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

/** Listen on an ephemeral port of `host`; null when the machine has no such address (IPv6 off). */
function hold(host: string): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code && NO_SUCH_ADDRESS.has(err.code)) resolve(null);
      else reject(err);
    });
    server.listen(0, host, () => resolve(server));
  });
}

function portOf(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('portProblem — real listeners on an ephemeral port', () => {
  // On Windows a bind on 0.0.0.0 or :: succeeds next to a listener on
  // 127.0.0.1 or ::1: each host has to be probed on its own
  for (const host of ['127.0.0.1', '0.0.0.0', '::', '::1']) {
    it(`sees a listener on ${host}`, async () => {
      const holder = await hold(host);
      if (!holder) return; // no IPv6 on this machine: nothing to hold
      try {
        expect(await portProblem(portOf(holder))).toMatch(/^something already listens on .+:\d+$/);
      } finally {
        await close(holder);
      }
    });
  }

  it('answers null for a port nothing listens on', async () => {
    const holder = await hold('127.0.0.1');
    const port = portOf(holder!);
    await close(holder!);
    expect(await portProblem(port)).toBeNull();
  });

  it('probes the two wildcards and both loopbacks', () => {
    expect([...PROBE_HOSTS].sort()).toEqual(['0.0.0.0', '127.0.0.1', '::', '::1'].sort());
  });
});

describe('probeBind', () => {
  it('reports free, then in use, for one host', async () => {
    const holder = await hold('127.0.0.1');
    const port = portOf(holder!);
    expect(await probeBind(port, '127.0.0.1')).toEqual({ state: 'in-use' });
    await close(holder!);
    expect(await probeBind(port, '127.0.0.1')).toEqual({ state: 'free' });
  });

  it('reports any other bind error as an error with its code, never as in use', async () => {
    // 192.0.2.1 (TEST-NET-1) is never a local address
    const result = await probeBind(0, '192.0.2.1');
    expect(result.state).toBe('error');
    expect(result).toMatchObject({ code: 'EADDRNOTAVAIL' });
  });
});

describe('portProblem — decisions on probe results', () => {
  afterEach(() => vi.restoreAllMocks());

  const free = { state: 'free' } as const;

  it('reports an error other than EADDRINUSE as itself (EACCES)', async () => {
    const probe = vi.fn(async (_port: number, host: string) =>
      host === '0.0.0.0' ? { state: 'error' as const, code: 'EACCES', message: 'listen EACCES' } : free,
    );
    expect(await portProblem(3001, { probe })).toBe('cannot bind 0.0.0.0:3001 to check it (EACCES)');
  });

  it('skips an IPv6 host the machine does not have', async () => {
    const probe = vi.fn(async (_port: number, host: string) =>
      host.includes(':') ? { state: 'error' as const, code: 'EADDRNOTAVAIL', message: 'no v6' } : free,
    );
    expect(await portProblem(3001, { probe })).toBeNull();
    expect(probe).toHaveBeenCalledTimes(PROBE_HOSTS.length);
  });

  it('does not skip a missing IPv4 address', async () => {
    const probe = vi.fn(async (_port: number, host: string) =>
      host === '127.0.0.1' ? { state: 'error' as const, code: 'EADDRNOTAVAIL', message: 'no v4 loopback' } : free,
    );
    expect(await portProblem(3001, { probe })).toBe('cannot bind 127.0.0.1:3001 to check it (EADDRNOTAVAIL)');
  });

  it('names the host where the port is taken and stops probing there', async () => {
    const probe = vi.fn(async (_port: number, host: string) => (host === '::' ? { state: 'in-use' as const } : free));
    expect(await portProblem(3002, { hosts: ['0.0.0.0', '::', '127.0.0.1'], probe })).toBe('something already listens on :::3002');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('falls back to the message when an error has no code', async () => {
    const probe = vi.fn(async () => ({ state: 'error' as const, code: undefined, message: 'weird failure' }));
    expect(await portProblem(3001, { hosts: ['0.0.0.0'], probe })).toBe('cannot bind 0.0.0.0:3001 to check it (weird failure)');
  });
});

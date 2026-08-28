import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── mediasoup fake ──────────────────────────────────────────────────────────
//
// The manager is exercised against a fake worker/router/server so the port
// arithmetic, the WebRtcServer-per-worker wiring and the crash-restart slot
// reuse can be asserted without spawning the C++ worker.

type Listener = (...args: unknown[]) => void;

interface FakeServer { id: string; closed: boolean; listenInfos: unknown; close: () => void }
interface FakeRouter { closed: boolean; createWebRtcTransport: ReturnType<typeof vi.fn>; close: () => void }
interface FakeWorker {
  pid: number;
  closed: boolean;
  listeners: Record<string, Listener[]>;
  servers: FakeServer[];
  createWebRtcServer: ReturnType<typeof vi.fn>;
  createRouter: ReturnType<typeof vi.fn>;
  getResourceUsage: ReturnType<typeof vi.fn>;
  on: (event: string, cb: Listener) => void;
  emit: (event: string, ...args: unknown[]) => void;
  close: () => void;
}

const workersCreated: FakeWorker[] = [];
let nextPid = 100;
// Per-call overrides for createWebRtcServer, keyed by creation order
let serverFailures: Array<Error | null> = [];

function makeWorker(): FakeWorker {
  const w: FakeWorker = {
    pid: nextPid++,
    closed: false,
    listeners: {},
    servers: [],
    createWebRtcServer: vi.fn(async ({ listenInfos }: { listenInfos: unknown }) => {
      const failure = serverFailures.shift() ?? null;
      if (failure) throw failure;
      const server: FakeServer = { id: `srv-${w.pid}`, closed: false, listenInfos, close() { this.closed = true; } };
      w.servers.push(server);
      return server;
    }),
    createRouter: vi.fn(async () => {
      const router: FakeRouter = {
        closed: false,
        createWebRtcTransport: vi.fn(async (opts: unknown) => ({ id: 'transport', opts, close: vi.fn() })),
        close() { this.closed = true; },
      };
      return router;
    }),
    getResourceUsage: vi.fn(async () => ({ ru_utime: 1, ru_stime: 1, ru_maxrss: 1 })),
    on(event, cb) { (w.listeners[event] ??= []).push(cb); },
    emit(event, ...args) { for (const cb of w.listeners[event] ?? []) cb(...args); },
    close() { w.closed = true; },
  };
  workersCreated.push(w);
  return w;
}

vi.mock('mediasoup', () => ({
  createWorker: vi.fn(async () => makeWorker()),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, cpus: () => [{}, {}, {}] }, cpus: () => [{}, {}, {}] };
});

type Manager = typeof import('../../mediasoup/mediasoupManager');

async function freshManager(): Promise<Manager> {
  vi.resetModules();
  return import('../../mediasoup/mediasoupManager');
}

const ENV_KEYS = ['MEDIASOUP_LISTEN_IP', 'MEDIASOUP_ANNOUNCED_IP', 'MEDIASOUP_MIN_PORT', 'MEDIASOUP_MAX_PORT', 'MEDIASOUP_NUM_WORKERS', 'MEDIASOUP_WEBRTC_SERVER'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.MEDIASOUP_ANNOUNCED_IP = '203.0.113.10';
  process.env.MEDIASOUP_MIN_PORT = '10000';
  process.env.MEDIASOUP_MAX_PORT = '19999';
  workersCreated.length = 0;
  serverFailures = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── WebRtcServer mode (default) ─────────────────────────────────────────────

describe('mediasoupManager — one WebRtcServer per worker', () => {
  it('creates one worker per core (capped) and binds each a udp+tcp pair on MIN_PORT + slot', async () => {
    const m = await freshManager();
    await m.initMediasoup();

    expect(m.getWorkerCount()).toBe(3);
    expect(workersCreated).toHaveLength(3);
    workersCreated.forEach((w, i) => {
      expect(w.createWebRtcServer).toHaveBeenCalledTimes(1);
      const { listenInfos } = w.createWebRtcServer.mock.calls[0][0] as { listenInfos: Array<Record<string, unknown>> };
      expect(listenInfos).toEqual([
        { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '203.0.113.10', port: 10000 + i },
        { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: '203.0.113.10', port: 10000 + i },
      ]);
    });
    expect(m.getWebRtcServerPorts()).toEqual([10000, 10001, 10002]);
  });

  it('honours MEDIASOUP_NUM_WORKERS below the core count', async () => {
    process.env.MEDIASOUP_NUM_WORKERS = '2';
    const m = await freshManager();
    await m.initMediasoup();
    expect(m.getWorkerCount()).toBe(2);
    expect(m.getWebRtcServerPorts()).toEqual([10000, 10001]);
  });

  it('gives a transport the WebRtcServer of the router\'s OWN worker, and no listenInfos', async () => {
    const m = await freshManager();
    await m.initMediasoup();

    // Round-robin: channel A → worker 0, B → worker 1, C → worker 2
    const routers = await Promise.all(['a', 'b', 'c'].map((id) => m.getOrCreateRouter(id)));
    for (let i = 0; i < 3; i++) {
      await m.createWebRtcTransport(routers[i]);
      const opts = (routers[i] as unknown as FakeRouter).createWebRtcTransport.mock.calls[0][0] as Record<string, unknown>;
      expect(opts.webRtcServer).toBe(workersCreated[i].servers[0]);
      expect(opts).not.toHaveProperty('listenInfos');
      expect(opts).toMatchObject({ enableUdp: true, enableTcp: true, preferUdp: true, initialAvailableOutgoingBitrate: 600_000 });
    }
  });

  // Falling back to a per-transport listen here would hand out ports the
  // firewall no longer opens — a join that "succeeds" into a dead transport.
  it('refuses to create a transport on a router whose worker has no live server', async () => {
    const m = await freshManager();
    await m.initMediasoup();
    const foreignRouter = { closed: false, createWebRtcTransport: vi.fn() } as unknown as Parameters<Manager['createWebRtcTransport']>[0];
    await expect(m.createWebRtcTransport(foreignRouter)).rejects.toThrow(/No live WebRtcServer/);
    expect((foreignRouter as unknown as FakeRouter).createWebRtcTransport).not.toHaveBeenCalled();

    const router = await m.getOrCreateRouter('x');
    workersCreated[0].servers[0].closed = true;
    await expect(m.createWebRtcTransport(router)).rejects.toThrow(/No live WebRtcServer/);
  });

  it('fails at boot, before creating any worker, when the range has fewer ports than workers', async () => {
    process.env.MEDIASOUP_MAX_PORT = '10001'; // two ports, three workers
    const m = await freshManager();
    await expect(m.initMediasoup()).rejects.toThrow(/has no port for worker #2/);
    expect(workersCreated).toHaveLength(0);
  });

  it('closes a worker whose WebRtcServer failed to bind and surfaces the failure', async () => {
    serverFailures = [null, new Error('EADDRINUSE')];
    const m = await freshManager();
    await expect(m.initMediasoup()).rejects.toThrow(/Failed to bind WebRtcServer port 10001 for worker #1: EADDRINUSE/);
    expect(workersCreated[1].closed).toBe(true);
    expect(workersCreated[0].closed).toBe(false);
  });

  it('a replacement worker after a crash re-binds the SAME port slot', async () => {
    vi.useFakeTimers();
    const m = await freshManager();
    await m.initMediasoup();
    const deaths: string[][] = [];
    m.onWorkerDeath((ids) => deaths.push(ids));

    // Channel on worker 1 (second in the round-robin)
    await m.getOrCreateRouter('first');
    await m.getOrCreateRouter('on-worker-1');
    const dead = workersCreated[1];
    dead.emit('died', new Error('segfault'));

    expect(m.getWorkerCount()).toBe(2);
    expect(m.getWebRtcServerPorts()).toEqual([10000, 10002]); // slot 1 vacated
    expect(deaths).toEqual([['on-worker-1']]);
    expect(m.getRouter('on-worker-1')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000); // first restart delay
    expect(m.getWorkerCount()).toBe(3);
    const replacement = workersCreated[3];
    const { listenInfos } = replacement.createWebRtcServer.mock.calls[0][0] as { listenInfos: Array<{ port: number }> };
    expect(listenInfos.map((l) => l.port)).toEqual([10001, 10001]);
    expect(m.getWebRtcServerPorts()).toEqual([10000, 10001, 10002]);
  });

  it('reports the WebRtcServer ports in the SFU stats', async () => {
    const m = await freshManager();
    await m.initMediasoup();
    const stats = await m.getSfuStats();
    expect(stats.webRtcServer).toEqual({ ports: [10000, 10001, 10002] });
    expect(stats.portRange).toEqual({ min: 10000, max: 19999, total: 10000 });
  });
});

// ─── Per-transport listen mode (escape hatch) ────────────────────────────────

describe('mediasoupManager — MEDIASOUP_WEBRTC_SERVER=false', () => {
  beforeEach(() => { process.env.MEDIASOUP_WEBRTC_SERVER = 'false'; });

  it('creates no WebRtcServer and lets each transport bind its own udp+tcp ports', async () => {
    const m = await freshManager();
    await m.initMediasoup();
    for (const w of workersCreated) expect(w.createWebRtcServer).not.toHaveBeenCalled();
    expect(m.getWebRtcServerPorts()).toEqual([]);

    const router = await m.getOrCreateRouter('a');
    await m.createWebRtcTransport(router);
    const opts = (router as unknown as FakeRouter).createWebRtcTransport.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('webRtcServer');
    expect(opts.listenInfos).toEqual([
      { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '203.0.113.10' },
      { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: '203.0.113.10' },
    ]);
  });

  it('does not apply the one-port-per-worker range check', async () => {
    process.env.MEDIASOUP_MAX_PORT = '10001';
    const m = await freshManager();
    await expect(m.initMediasoup()).resolves.toBeUndefined();
    expect(m.getWorkerCount()).toBe(3);
  });

  it('reports null for webRtcServer in the SFU stats so the admin shows the port-usage bar', async () => {
    const m = await freshManager();
    await m.initMediasoup();
    expect((await m.getSfuStats()).webRtcServer).toBeNull();
  });
});

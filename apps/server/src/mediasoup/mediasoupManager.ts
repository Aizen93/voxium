import * as mediasoup from 'mediasoup';
import type { Worker, Router, WebRtcTransport, WebRtcServer } from 'mediasoup/node/lib/types';
import type { SfuStats, SfuWorkerStats } from '@voxium/shared';
import os from 'os';
import {
  mediaCodecs,
  getWorkerSettings,
  getWebRtcTransportOptions,
  getWebRtcServerListenInfos,
  getWebRtcServerTransportOptions,
  useWebRtcServer,
  webRtcServerPort,
} from './mediasoupConfig';

// ─── State ───────────────────────────────────────────────────────────────────

const workers: Worker[] = [];
let nextWorkerIdx = 0;

// Each worker's WebRtcServer — the ONE udp+tcp port pair every transport on
// that worker shares (mediasoupConfig.useWebRtcServer). Empty in the
// per-transport listen mode.
const webRtcServers = new Map<Worker, WebRtcServer>();
// The worker's slot index, which fixes its WebRtcServer port
// (MEDIASOUP_MIN_PORT + slot). A replacement worker after a crash inherits the
// slot so it re-binds the very same ports.
const workerSlot = new Map<Worker, number>();
// The port each live WebRtcServer actually bound — recorded at creation so
// stats never re-derive it from env (which can throw) after the fact.
const boundPorts = new Map<Worker, number>();
// Router → the worker it was created on, for picking that worker's WebRtcServer
// when a transport is created. Weak: routers are closed and dropped freely.
const routerOwner = new WeakMap<Router, Worker>();

// Invoked with the affected channelIds when a worker dies, so the voice layer
// can tear down stranded sessions and tell clients to rejoin (instead of
// leaving them in a silently dead channel). Wired by index.ts after Socket.IO
// is initialized — deaths before that have no connected users to notify.
type WorkerDeathListener = (channelIds: string[]) => void;
let workerDeathListener: WorkerDeathListener | null = null;
export function onWorkerDeath(listener: WorkerDeathListener): void {
  workerDeathListener = listener;
}

// channelId → Router
const channelRouters = new Map<string, Router>();
// Track which worker owns each router (for cleanup on worker death)
const routerWorkerMap = new Map<string, Worker>();
// Pending router creation promises to prevent TOCTOU races
const pendingRouters = new Map<string, Promise<Router>>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize mediasoup workers. Call once at startup.
 * Creates 1 worker per CPU core, capped at configurable max.
 */
export async function initMediasoup(): Promise<void> {
  const numCores = os.cpus().length;
  const maxWorkers = parseInt(process.env.MEDIASOUP_NUM_WORKERS || '0', 10) || numCores;
  const numWorkers = Math.min(numCores, maxWorkers, 8); // cap at 8

  if (useWebRtcServer()) {
    // Fail at boot, not at the first join: every worker needs its own port.
    webRtcServerPort(numWorkers - 1);
  }

  console.log(`[mediasoup] Creating ${numWorkers} worker(s)...`);

  try {
    for (let i = 0; i < numWorkers; i++) {
      const worker = await createWorker(i);
      workers.push(worker);
    }
  } catch (err) {
    // Boot is about to fail (index.ts exits). Do not leave the workers that
    // DID come up as orphaned mediasoup child processes holding their ports —
    // the very thing that would make the next boot fail the same way.
    for (const w of workers) {
      try { w.close(); } catch (closeErr) { console.error('[mediasoup] Failed to close worker during init rollback:', closeErr); }
    }
    workers.length = 0;
    webRtcServers.clear();
    workerSlot.clear();
    boundPorts.clear();
    throw err;
  }

  if (useWebRtcServer()) {
    console.log(`[mediasoup] ${workers.length} worker(s) ready — WebRtcServer ports ${getWebRtcServerPorts().join(', ')} (udp+tcp)`);
  } else {
    console.log(`[mediasoup] ${workers.length} worker(s) ready — per-transport ports ${getWorkerSettings().rtcMinPort}-${getWorkerSettings().rtcMaxPort}`);
  }
}

/**
 * Get or create a Router for a voice channel (lazy).
 * Each voice channel gets its own Router on a round-robin Worker.
 */
export async function getOrCreateRouter(channelId: string): Promise<Router> {
  const existing = channelRouters.get(channelId);
  if (existing && !existing.closed) return existing;

  // If a creation is already in flight for this channel, await it
  const pending = pendingRouters.get(channelId);
  if (pending) return pending;

  if (workers.length === 0) {
    throw new Error('No mediasoup workers available');
  }

  const promise = (async () => {
    const worker = getNextWorker();
    const router = await worker.createRouter({ mediaCodecs });
    channelRouters.set(channelId, router);
    routerWorkerMap.set(channelId, worker);
    routerOwner.set(router, worker);
    console.log(`[mediasoup] Created Router for channel ${channelId} on worker pid=${worker.pid}`);
    return router;
  })();

  pendingRouters.set(channelId, promise);
  // Always clear the pending entry once settled — on success AND failure. A rejected
  // createRouter() (e.g. transient worker death) must not stay cached, or every future
  // join to this channel would receive the same stale rejection until process restart.
  // The identity check avoids clobbering a newer creation that already replaced this one.
  promise
    .finally(() => {
      if (pendingRouters.get(channelId) === promise) pendingRouters.delete(channelId);
    })
    .catch(() => { /* rejection is surfaced to awaiting callers; nothing to do here */ });
  return promise;
}

/**
 * Release a Router when the last user leaves a voice channel.
 */
export function releaseRouter(channelId: string): void {
  // Cancel any in-flight router creation for this channel
  pendingRouters.delete(channelId);
  const router = channelRouters.get(channelId);
  if (router && !router.closed) {
    router.close();
    console.log(`[mediasoup] Closed Router for channel ${channelId}`);
  }
  channelRouters.delete(channelId);
  routerWorkerMap.delete(channelId);
}

/**
 * Create a WebRtcTransport on the given Router.
 *
 * In WebRtcServer mode the transport rides the router's worker's server — it
 * binds no port of its own. A router without a known owner (only possible if
 * it was not created through getOrCreateRouter) or a worker without a server
 * is a bug, not a case to paper over: falling back to a per-transport listen
 * would silently hand out ports the firewall no longer opens, and the join
 * would "succeed" into a transport nobody can reach.
 */
export async function createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
  if (!useWebRtcServer()) {
    return router.createWebRtcTransport(getWebRtcTransportOptions());
  }
  const worker = routerOwner.get(router);
  const webRtcServer = worker ? webRtcServers.get(worker) : undefined;
  if (!webRtcServer || webRtcServer.closed) {
    throw new Error("[mediasoup] No live WebRtcServer for this router's worker");
  }
  return router.createWebRtcTransport(getWebRtcServerTransportOptions(webRtcServer));
}

/** The udp+tcp ports the live WebRtcServers listen on (sorted). Empty in per-transport mode. */
export function getWebRtcServerPorts(): number[] {
  const ports: number[] = [];
  for (const worker of workers) {
    const port = boundPorts.get(worker);
    if (port !== undefined) ports.push(port);
  }
  return ports.sort((a, b) => a - b);
}

/**
 * Close all Routers for a given server's channels (used on server deletion).
 */
export function releaseServerRouters(channelIds: string[]): void {
  for (const channelId of channelIds) {
    releaseRouter(channelId);
  }
}

/** Returns count of alive workers */
export function getWorkerCount(): number {
  return workers.length;
}

/** Gather SFU infrastructure stats for the admin dashboard. */
export async function getSfuStats(channelTransports?: Map<string, number>): Promise<SfuStats> {
  const workerStats: SfuWorkerStats[] = await Promise.all(
    workers.map(async (w) => {
      try {
        const usage = await w.getResourceUsage();
        let routerCount = 0;
        let transportCount = 0;
        for (const [channelId, assignedWorker] of routerWorkerMap.entries()) {
          if (assignedWorker === w) {
            routerCount++;
            transportCount += channelTransports?.get(channelId) ?? 0;
          }
        }
        return {
          pid: w.pid,
          routerCount,
          transportCount,
          cpuUser: usage.ru_utime,
          cpuSystem: usage.ru_stime,
          memoryRss: usage.ru_maxrss,
        };
      } catch {
        return { pid: w.pid, routerCount: 0, transportCount: 0, cpuUser: 0, cpuSystem: 0, memoryRss: 0 };
      }
    }),
  );

  const portMin = getWorkerSettings().rtcMinPort;
  const portMax = getWorkerSettings().rtcMaxPort;

  return {
    workers: workerStats,
    totalRouters: channelRouters.size,
    portRange: { min: portMin, max: portMax, total: portMax - portMin + 1 },
    // null = per-transport listen mode, where portRange.total bounds the
    // transport count; with WebRtcServers it does not.
    webRtcServer: useWebRtcServer() ? { ports: getWebRtcServerPorts() } : null,
  };
}

/** Returns the Router for a channel (or undefined if none) */
export function getRouter(channelId: string): Router | undefined {
  const router = channelRouters.get(channelId);
  return router && !router.closed ? router : undefined;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function getNextWorker(): Worker {
  const worker = workers[nextWorkerIdx % workers.length];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

/**
 * Consecutive restart failures PER SLOT, for exponential backoff. One shared
 * counter let a slot whose port is permanently taken pin every other slot's
 * first restart at the 30 s ceiling — and let any success drop the failing
 * slot back to a 2 s spawn-and-close loop.
 */
const restartAttempts = new Map<number, number>();

async function createWorker(slot: number): Promise<Worker> {
  const worker = await mediasoup.createWorker({
    logLevel: getWorkerSettings().logLevel,
    rtcMinPort: getWorkerSettings().rtcMinPort,
    rtcMaxPort: getWorkerSettings().rtcMaxPort,
  });
  workerSlot.set(worker, slot);

  if (useWebRtcServer()) {
    const listenInfos = getWebRtcServerListenInfos(slot);
    try {
      const server = await worker.createWebRtcServer({ listenInfos });
      webRtcServers.set(worker, server);
      boundPorts.set(worker, listenInfos[0].port!);
    } catch (err) {
      // A worker without its server would accept routers and then fail every
      // transport (createWebRtcTransport refuses to fall back). Close it and
      // surface the bind failure: at boot that stops the process; on a restart
      // it lands in the backoff retry below.
      workerSlot.delete(worker);
      worker.close();
      throw new Error(
        `[mediasoup] Failed to bind WebRtcServer port ${listenInfos[0].port} for worker #${slot}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  worker.on('died', (error) => {
    console.error(`[mediasoup] Worker pid=${worker.pid} died:`, error);

    // Remove dead worker; its WebRtcServer died with it, and its slot (port)
    // is what the replacement must take over.
    const idx = workers.indexOf(worker);
    if (idx !== -1) workers.splice(idx, 1);
    webRtcServers.delete(worker);
    workerSlot.delete(worker);
    boundPorts.delete(worker);

    // Close all Routers that were on this worker
    const affectedChannels: string[] = [];
    for (const [channelId, w] of routerWorkerMap.entries()) {
      if (w === worker) {
        affectedChannels.push(channelId);
        channelRouters.delete(channelId);
        routerWorkerMap.delete(channelId);
      }
    }

    // Let the voice layer evict the stranded participants and notify their
    // clients — otherwise they sit in a dead channel until a manual rejoin
    if (affectedChannels.length > 0 && workerDeathListener) {
      try {
        workerDeathListener(affectedChannels);
      } catch (err) {
        console.error('[mediasoup] Worker-death listener failed:', err);
      }
    }

    scheduleWorkerRestart(slot);
  });

  console.log(`[mediasoup] Worker pid=${worker.pid} created`);
  return worker;
}

/**
 * Restart a dead worker's slot with exponential backoff (2s, 4s, 8s … 30s max),
 * and KEEP retrying when the restart itself fails. A failed restart used to
 * be logged and abandoned, which was tolerable when creating a worker could
 * only fail on a broken install; with a WebRtcServer the replacement must
 * re-bind the slot's port, and a bind failure is exactly the transient kind
 * (the dead process's socket not yet released) that a second attempt fixes.
 * Abandoning it leaves the node one worker short — silently, for the rest
 * of the process's life.
 */
function scheduleWorkerRestart(slot: number): void {
  const attempt = (restartAttempts.get(slot) ?? 0) + 1;
  restartAttempts.set(slot, attempt);
  const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
  console.log(`[mediasoup] Scheduling worker restart for slot #${slot} in ${delay}ms (attempt ${attempt})`);

  setTimeout(async () => {
    try {
      console.log(`[mediasoup] Restarting dead worker (slot #${slot})...`);
      const newWorker = await createWorker(slot);
      workers.push(newWorker);
      restartAttempts.delete(slot); // Reset THIS slot's backoff on success
      console.log(`[mediasoup] Replacement worker pid=${newWorker.pid} ready`);
    } catch (err) {
      console.error(`[mediasoup] Failed to restart worker for slot #${slot}:`, err);
      if (workers.length === 0) {
        console.error('[mediasoup] CRITICAL: All workers dead and restart failed. Voice is unavailable until a retry succeeds.');
      }
      scheduleWorkerRestart(slot);
    }
  }, delay);
}

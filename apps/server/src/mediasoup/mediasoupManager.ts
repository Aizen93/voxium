import * as mediasoup from 'mediasoup';
import type { Worker, Router, WebRtcTransport } from 'mediasoup/node/lib/types';
import type { SfuStats, SfuWorkerStats } from '@voxium/shared';
import os from 'os';
import { mediaCodecs, getWorkerSettings, getWebRtcTransportOptions } from './mediasoupConfig';

// ─── State ───────────────────────────────────────────────────────────────────

const workers: Worker[] = [];
let nextWorkerIdx = 0;

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

  console.log(`[mediasoup] Creating ${numWorkers} worker(s)...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await createWorker();
    workers.push(worker);
  }

  console.log(`[mediasoup] ${workers.length} worker(s) ready`);
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
    pendingRouters.delete(channelId);
    console.log(`[mediasoup] Created Router for channel ${channelId} on worker pid=${worker.pid}`);
    return router;
  })();

  pendingRouters.set(channelId, promise);
  return promise;
}

/**
 * Release a Router when the last user leaves a voice channel.
 */
export function releaseRouter(channelId: string): void {
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
 */
export async function createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
  const transport = await router.createWebRtcTransport(getWebRtcTransportOptions());
  return transport;
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

/** Tracks consecutive restart failures for exponential backoff. */
let workerRestartAttempts = 0;

async function createWorker(): Promise<Worker> {
  const worker = await mediasoup.createWorker({
    logLevel: getWorkerSettings().logLevel,
    rtcMinPort: getWorkerSettings().rtcMinPort,
    rtcMaxPort: getWorkerSettings().rtcMaxPort,
  });

  worker.on('died', (error) => {
    console.error(`[mediasoup] Worker pid=${worker.pid} died:`, error);

    // Remove dead worker
    const idx = workers.indexOf(worker);
    if (idx !== -1) workers.splice(idx, 1);

    // Close all Routers that were on this worker
    for (const [channelId, w] of routerWorkerMap.entries()) {
      if (w === worker) {
        channelRouters.delete(channelId);
        routerWorkerMap.delete(channelId);
      }
    }

    // Attempt to restart with exponential backoff (50ms, 100ms, 200ms, ... 30s max)
    workerRestartAttempts++;
    const delay = Math.min(2000 * Math.pow(2, workerRestartAttempts - 1), 30000);
    console.log(`[mediasoup] Scheduling worker restart in ${delay}ms (attempt ${workerRestartAttempts})`);

    setTimeout(async () => {
      try {
        console.log('[mediasoup] Restarting dead worker...');
        const newWorker = await createWorker();
        workers.push(newWorker);
        workerRestartAttempts = 0; // Reset on success
        console.log(`[mediasoup] Replacement worker pid=${newWorker.pid} ready`);
      } catch (err) {
        console.error('[mediasoup] Failed to restart worker:', err);
        if (workers.length === 0) {
          console.error('[mediasoup] CRITICAL: All workers dead and restart failed. Voice will be unavailable.');
        }
      }
    }, delay);
  });

  console.log(`[mediasoup] Worker pid=${worker.pid} created`);
  return worker;
}

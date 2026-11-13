// Pre-flight for a script that starts its own cluster against the local
// Redis (scripts/test-multi-node.ts): no OTHER node may hold a heartbeat.
//
// Every server process keeps `node:alive:{NODE_ID}` in Redis (30 s TTL,
// refreshed every 10 s: apps/server/src/utils/redis.ts) and its peers count
// those keys. A backend that was killed rather than shut down leaves its key
// behind until the TTL runs out, and for that long a cluster started next to
// it counts one node more than it has: a visibility resync is received by
// fewer subscribers than there are live nodes and retries, the reapers refuse
// their snapshot. A run started within 30 s of stopping another backend
// failed its "confirmed at the first publish" check for that reason alone.

/** The key pattern of the node heartbeats (apps/server/src/utils/redis.ts). */
export const HEARTBEAT_PATTERN = 'node:alive:*';

/**
 * How long a leftover heartbeat is waited for: its 30 s TTL and a margin. A
 * key still there after it is being refreshed by a running server.
 */
export const HEARTBEAT_EXPIRY_WAIT_MS = 35_000;

/** The node id a heartbeat key names. */
function nodeIdOf(key) {
  return key.startsWith('node:alive:') ? key.slice('node:alive:'.length) : key;
}

/**
 * Waits until no node heartbeat is left, and returns null; or, when one is
 * still there after `timeoutMs`, why the cluster cannot start. A leftover key
 * expires by itself, so the wait ends as soon as the last one is gone.
 *
 * @param {object} options
 * @param {() => Promise<string[]>} options.list the heartbeat keys present now
 * @param {(ms: number) => Promise<void>} [options.sleep] exists for the tests
 * @param {() => number} [options.now] exists for the tests
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {(line: string) => void} [options.log] told once, when the wait starts
 * @returns {Promise<string | null>}
 */
export async function foreignNodeProblem({
  list,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = HEARTBEAT_EXPIRY_WAIT_MS,
  pollMs = 1000,
  log = () => {},
}) {
  const startedAt = now();
  let announced = false;
  for (;;) {
    const keys = await list();
    if (keys.length === 0) return null;
    const names = keys.map(nodeIdOf).sort().join(', ');
    if (now() - startedAt >= timeoutMs) {
      return `another server holds a heartbeat in this Redis (${names}) and keeps it alive: stop it and run again`;
    }
    if (!announced) {
      announced = true;
      log(`Waiting for the heartbeat of ${names} to expire (a server stopped moments ago keeps it for up to 30 s)...`);
    }
    await sleep(pollMs);
  }
}

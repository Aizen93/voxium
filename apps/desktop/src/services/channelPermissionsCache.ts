/**
 * The viewer's effective permissions in one channel of a space, held for the
 * session: the shared answer behind `hooks/useChannelPermissions`.
 *
 * Nothing at the transport merges identical requests, so the request for one
 * (account, space, channel, role fingerprint, generation) is made ONCE however
 * many components ask: the others wait on the same promise. An answer is kept
 * only while its key still stands: an event that can change a channel's bits
 * (an override write, leaving the space, logout) drops the entries and the
 * requests in flight, so an answer that lands afterwards is never kept.
 *
 * Imports nothing, so a store can forget a space without a cycle.
 */

const CACHE_MAX = 128;

interface Held {
  serverId: string;
  bits: string;
}
interface Pending {
  serverId: string;
  promise: Promise<string>;
}

const answers = new Map<string, Held>();
const pending = new Map<string, Pending>();
/** Per space: bumped by every invalidation, part of every key. */
const generations = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

/** The generation a key for this space carries now (0 until invalidated). */
export function channelPermissionsGeneration(serverId: string | null | undefined): number {
  return serverId ? generations.get(serverId) ?? 0 : 0;
}

export function subscribeChannelPermissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function cachedChannelPermissions(key: string): string | undefined {
  return answers.get(key)?.bits;
}

/** Forget one answer (a reconnect: the roles may have changed meanwhile). */
export function dropChannelPermissionsKey(key: string): void {
  answers.delete(key);
  pending.delete(key);
}

/**
 * The answer for `key`: the one held, the request already in flight, or the
 * one `load` makes. A failure is shared by everyone waiting and kept by nobody.
 */
export function loadChannelPermissions(key: string, serverId: string, load: () => Promise<string>): Promise<string> {
  const held = answers.get(key);
  if (held) return Promise.resolve(held.bits);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight.promise;
  const entry: Pending = { serverId, promise: Promise.resolve('') };
  entry.promise = load().then(
    (bits) => {
      // Still the request of record: the key was not dropped while it ran
      if (pending.get(key) === entry) {
        pending.delete(key);
        if (answers.size >= CACHE_MAX) {
          const oldest = answers.keys().next().value;
          if (oldest !== undefined) answers.delete(oldest);
        }
        answers.set(key, { serverId, bits });
      }
      return bits;
    },
    (err: unknown) => {
      if (pending.get(key) === entry) pending.delete(key);
      throw err;
    },
  );
  pending.set(key, entry);
  return entry.promise;
}

function dropServer(serverId: string): void {
  for (const [k, v] of [...answers]) if (v.serverId === serverId) answers.delete(k);
  for (const [k, v] of [...pending]) if (v.serverId === serverId) pending.delete(k);
}

/**
 * A channel's bits may have changed in this space (an override write): every
 * answer and request of the space is dropped, and the components asking ask
 * again under the next generation.
 */
export function invalidateChannelPermissions(serverId: string): void {
  generations.set(serverId, channelPermissionsGeneration(serverId) + 1);
  dropServer(serverId);
  notify();
}

/** The viewer left, was removed from or lost this space: nothing of it stays. */
export function forgetSpaceChannelPermissions(serverId: string): void {
  dropServer(serverId);
  generations.delete(serverId);
}

/** Logout: the answers are the leaving account's. */
export function resetChannelPermissionsCache(): void {
  answers.clear();
  pending.clear();
  generations.clear();
  notify();
}

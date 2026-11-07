/**
 * A counter that says "the server's state may have changed since": bumped by
 * every write the REST client sends and by every event the socket delivers.
 *
 * The REST client coalesces identical GETs in flight (services/api.ts). A GET
 * issued AFTER a write or a socket event must not join one issued BEFORE it:
 * it would receive the pre-change answer, and a store that refetched because
 * of the event would keep stale data until the next refetch (the permission
 * hook even caches it under the new fingerprint). The generation is part of
 * the coalescing key, so such a GET starts a request of its own; followers
 * that already joined a leader keep it.
 *
 * Its own module so that services/api.ts and services/socket.ts can both
 * reach it without importing each other.
 */
let generation = 0;

export function requestGeneration(): number {
  return generation;
}

export function bumpRequestGeneration(): void {
  generation++;
}

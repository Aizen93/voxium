/**
 * Plaintext media files the person already played, kept in memory so a row
 * that scrolls out of the virtualised list and back is not fetched again.
 * Blobs, not blob URLs: every mounted player makes and revokes its own URL, so
 * an eviction never pulls a URL out from under a player. Bounded in entries
 * AND bytes, least recently used out first. Never written to storage, and
 * emptied when the account signs out (`resetAccountStores`). Decrypted
 * (end-to-end) media never enters it. This module imports nothing.
 */
export const MEDIA_CACHE_MAX_ENTRIES = 4;
export const MEDIA_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const cache = new Map<string, Blob>();

export function getCachedMedia(key: string): Blob | null {
  const blob = cache.get(key);
  if (!blob) return null;
  cache.delete(key);
  cache.set(key, blob);
  return blob;
}

export function rememberMedia(key: string, blob: Blob): void {
  if (blob.size > MEDIA_CACHE_MAX_BYTES) return;
  cache.delete(key);
  cache.set(key, blob);
  let total = 0;
  for (const b of cache.values()) total += b.size;
  for (const k of [...cache.keys()]) {
    if (cache.size <= MEDIA_CACHE_MAX_ENTRIES && total <= MEDIA_CACHE_MAX_BYTES) break;
    total -= cache.get(k)?.size ?? 0;
    cache.delete(k);
  }
}

export function resetMediaCache(): void {
  cache.clear();
}
